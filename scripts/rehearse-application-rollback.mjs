import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import console from 'node:console'
import process from 'node:process'
import { setTimeout } from 'node:timers'
import { URL } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'

// Intentionally does not load .env or connect to an existing database. Every
// container runs on a generated internal network; no service is host-published and no hosted endpoint is reachable.
const [manifestPath, reportPath] = process.argv.slice(2)
if (!manifestPath || !reportPath)
  throw new Error('Supply an image manifest and evidence output path.')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
for (const name of ['currentApi', 'previousApi', 'currentWeb', 'previousWeb']) {
  const item = manifest[name]
  const repository = name.endsWith('Api') ? 'backend' : 'frontend'
  assert.match(
    item?.image ?? '',
    new RegExp(`^ghcr\\.io/ditero22/cbms-${repository}@sha256:[a-f0-9]{64}$`),
  )
  assert.match(item?.revision ?? '', /^[a-f0-9]{40}$/)
  const metadata = JSON.parse(await docker(['image', 'inspect', item.image]))[0]
  assert.equal(metadata.Config.Labels['org.opencontainers.image.revision'], item.revision)
}
const postgresId = (
  await docker(['image', 'inspect', 'postgres:17-alpine', '--format', '{{.Id}}'])
).trim()
assert.match(postgresId, /^sha256:[a-f0-9]{64}$/)

const run = `cbms-rollback-${randomBytes(6).toString('hex')}`
const ownerLabel = `cbms.rehearsal=${run}`
const containers = new Set()
let networkCreated = false
let volumeCreated = false
let phase = 'setup'
const startedAt = new Date()
const proofBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=',
  'base64',
)
const password = `Qa-${randomBytes(24).toString('hex')}`
const apiEnv = {
  NODE_ENV: 'production',
  PORT: '3000',
  AUTH_MODE: 'session',
  TRUST_PROXY: 'true',
  DATABASE_URL: `postgresql://qa:${randomBytes(24).toString('hex')}@db:5432/cbms_rollback`,
  SESSION_SECRET: randomBytes(48).toString('hex'),
  FRONTEND_URL: 'http://127.0.0.1',
  CORS_ORIGINS: 'http://127.0.0.1',
  LOCAL_UPLOAD_DIR: '/proofs',
  LOG_LEVEL: 'silent',
}
const fixture = {
  orderId: randomUUID(),
  paymentId: randomUUID(),
  attachmentId: randomUUID(),
  proofId: randomUUID(),
}
const checks = []
let evidence
try {
  await docker(['network', 'create', '--internal', '--label', ownerLabel, run])
  networkCreated = true
  await docker(['volume', 'create', '--label', ownerLabel, `${run}-proofs`])
  volumeCreated = true
  const db = await start(
    'db',
    postgresId,
    {
      POSTGRES_USER: 'qa',
      POSTGRES_DB: 'cbms_rollback',
      POSTGRES_PASSWORD: new URL(apiEnv.DATABASE_URL).password,
    },
    ['--network-alias', 'db'],
  )
  await until(async () => {
    try {
      await docker(['exec', db, 'pg_isready', '-U', 'qa', '-d', 'cbms_rollback'])
      return true
    } catch {
      return false
    }
  })

  phase = 'migrate disposable database'
  await oneShot(manifest.currentApi.image, ['node', 'dist/src/database/migrate.js'])
  phase = 'create synthetic isolated fixtures'
  await oneShot(
    manifest.currentApi.image,
    ['node', '--input-type=module'],
    fixtureWorker(),
    {
      QA_PASSWORD: password,
      QA_FIXTURE: JSON.stringify(fixture),
      QA_PROOF: proofBytes.toString('base64'),
    },
    ['--user', '0'],
  )

  phase = 'verify current images'
  let api = await start('api-current', manifest.currentApi.image, apiEnv, [
    '--network-alias',
    'api',
    '--volume',
    `${run}-proofs:/proofs:ro`,
  ])
  let web = await start('web-current', manifest.currentWeb.image, {}, ['--network-alias', 'web'])
  await verify(web, 'current')

  phase = 'inject isolated release configuration failure'
  await remove(web)
  await remove(api)
  // A missing database is a failed release configuration, not a data mutation.
  const failedEnv = {
    ...apiEnv,
    DATABASE_URL: apiEnv.DATABASE_URL.replace('/cbms_rollback', '/cbms_missing_release'),
  }
  api = await start('api-failed', manifest.currentApi.image, failedEnv, ['--network-alias', 'api'])
  await until(
    async () =>
      (await docker(['inspect', '--format', '{{.State.Running}}', api])).trim() === 'false',
  )
  const exitCode = Number(
    (await docker(['inspect', '--format', '{{.State.ExitCode}}', api])).trim(),
  )
  assert.notEqual(exitCode, 0)
  checks.push('Invalid release configuration failed closed')
  const rollbackStarted = Date.now()
  await remove(api)

  phase = 'rollback to previous published images'
  api = await start('api-previous', manifest.previousApi.image, apiEnv, [
    '--network-alias',
    'api',
    '--volume',
    `${run}-proofs:/proofs:ro`,
  ])
  web = await start('web-previous', manifest.previousWeb.image, {}, ['--network-alias', 'web'])
  await verify(web, 'rollback')
  const rollbackSeconds = (Date.now() - rollbackStarted) / 1000
  // Read-only SQL confirms the additive schema and linked financial records survived.
  const counts = JSON.parse(
    await oneShot(
      manifest.currentApi.image,
      ['node', '--input-type=module'],
      String.raw`
    import pg from 'pg';
    const db = new pg.Client({connectionString:process.env.DATABASE_URL}); await db.connect();
    const r = await db.query("select (select count(*) from drizzle.__drizzle_migrations)::int as migrations, (select count(*) from orders)::int as orders, (select count(*) from payments)::int as payments, (select count(*) from attachments)::int as proofs");
    console.log(JSON.stringify(r.rows[0])); await db.end();
  `,
    ),
  )
  assert.equal(counts.orders, 1)
  assert.equal(counts.payments, 1)
  assert.equal(counts.proofs, 1)
  evidence = {
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    artifacts: manifest,
    postgresId,
    checks,
    counts,
    rollbackSeconds,
    scope:
      'Isolated local published-image rollback with synthetic records and private local-format proof; not a native Render/Cloudflare rollback or a hosted R2 restore.',
  }
} catch {
  console.error(
    `Application rollback rehearsal failed during ${phase}. No existing environment was targeted.`,
  )
  process.exitCode = 1
} finally {
  for (const id of [...containers].reverse()) await remove(id)
  if (volumeCreated) await docker(['volume', 'rm', `${run}-proofs`])
  if (networkCreated) await docker(['network', 'rm', run])
}
if (evidence) {
  evidence.cleanupVerified = true
  await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' })
  console.info(
    `Application-image rollback passed: ${evidence.checks.length} checks; ${evidence.counts.migrations} migrations preserved; rollback ${evidence.rollbackSeconds}s; isolated resources removed.`,
  )
}

async function start(suffix, image, env, extra = []) {
  const id = (
    await docker(
      [
        'run',
        '-d',
        '--name',
        `${run}-${suffix}`,
        '--label',
        ownerLabel,
        '--network',
        run,
        ...extra,
        ...Object.keys(env).flatMap((key) => ['--env', key]),
        image,
      ],
      env,
    )
  ).trim()
  assert.match(id, /^[a-f0-9]{64}$/)
  containers.add(id)
  return id
}

async function oneShot(image, args, input, extraEnv = {}, options = []) {
  const env = { ...apiEnv, ...extraEnv }
  return docker(
    [
      'run',
      '--rm',
      '-i',
      '--label',
      ownerLabel,
      '--network',
      run,
      '--volume',
      `${run}-proofs:/proofs`,
      ...options,
      ...Object.keys(env).flatMap((key) => ['--env', key]),
      image,
      ...args,
    ],
    env,
    input,
  )
}

async function remove(id) {
  assert(containers.has(id), "Cleanup is restricted to this run's containers.")
  const label = (
    await docker(['inspect', '--format', '{{index .Config.Labels "cbms.rehearsal"}}', id])
  ).trim()
  assert.equal(label, run)
  await docker(['rm', '-f', '-v', id])
  containers.delete(id)
}

async function verify(web, label) {
  const ports = JSON.parse(
    await docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', web]),
  )
  assert(
    Object.values(ports).every((value) => value === null),
    'No test service may be host-published.',
  )
  const result = JSON.parse(
    await oneShot(
      manifest.currentApi.image,
      ['node', '--input-type=module'],
      verificationWorker(),
      {
        QA_PASSWORD: password,
        QA_FIXTURE: JSON.stringify(fixture),
        QA_PROOF: proofBytes.toString('base64'),
      },
    ),
  )
  phase = label + ': ' + result.phase
  assert.equal(result.passed, true)
  for (const check of result.checks) checks.push(label + ': ' + check)
}

function verificationWorker() {
  return String.raw`
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const f=JSON.parse(process.env.QA_FIXTURE);
const checks=[];
let phase='readiness';
try {
  const deadline=Date.now()+45000;
  let ready=false;
  while(Date.now()<deadline){
    try {ready=(await fetch('http://web:8080/api/ready',{signal:AbortSignal.timeout(1500)})).status===200;} catch {}
    if(ready) break;
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  assert(ready);
  phase='web assets';
  const html=await fetch('http://web:8080/login').then(r=>r.text());
  assert.match(html, /<div id="root">/);
  const asset=html.match(/src="(\/assets\/[^"\s]+\.js)"/)?.[1];
  assert(asset);
  assert.equal((await fetch('http://web:8080'+asset)).status,200);
  checks.push('web HTML, versioned asset, proxy and database readiness');
  // Simulate the trusted HTTPS ingress for secure cookies on this internal-only network.
  // This verifies the API contract; it does not claim a real browser TLS session.
  const origin='http://api:3000';
  const forwarded={'X-Forwarded-Proto':'https'};
  phase='login';
  const login=await fetch(origin+'/api/v1/auth/login',{method:'POST',headers:{...forwarded,'Content-Type':'application/json'},body:JSON.stringify({email:'rollback@example.invalid',password:process.env.QA_PASSWORD})});
  assert.equal(login.status,200);
  phase='secure session cookie';
  const setCookies=login.headers.getSetCookie();
  assert(setCookies.some(v=>/; Secure/i.test(v)));
  const cookie=setCookies.map(v=>v.split(';')[0]).join('; ');
  assert(cookie);
  const headers={...forwarded,cookie};
  phase='authenticated order/payment';
  assert.equal((await fetch(origin+'/api/v1/auth/me',{headers})).status,200);
  const response=await fetch(origin+'/api/v1/orders/'+f.orderId,{headers});
  assert.equal(response.status,200);
  const order=await response.json();
  assert.equal(order.paidAmount,'5.00'); assert.equal(order.balance,'0.00');
  checks.push('sign-in, secure session and matching synthetic order/payment');
  phase='private proof';
  const url=origin+'/api/v1/attachments/'+f.attachmentId+'/content';
  const proof=await fetch(url,{headers}); assert.equal(proof.status,200);
  assert.equal(proof.headers.get('cache-control'),'private, no-store');
  const bytes=Buffer.from(await proof.arrayBuffer());
  const expected=Buffer.from(process.env.QA_PROOF,'base64');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),createHash('sha256').update(expected).digest('hex'));
  assert.equal((await fetch(url)).status,401);
  checks.push('private proof byte match and anonymous denial');
  console.log(JSON.stringify({passed:true,phase,checks}));
} catch { console.log(JSON.stringify({passed:false,phase,checks})); }
`
}

async function until(check) {
  const deadline = Date.now() + 45_000
  do {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 300))
  } while (Date.now() < deadline)
  throw new Error('The isolated check timed out.')
}

async function docker(args, extraEnv = {}, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      env: { ...process.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    // Never return Docker stderr or configuration arguments: they can include credentials.
    child.stderr.resume()
    child.on('error', () => reject(new Error('Docker could not start.')))
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`Docker ${args[0]} failed (${code}).`)),
    )
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

function fixtureWorker() {
  return String.raw`
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { hashPassword } from './dist/src/shared/security/password.js';
const f=JSON.parse(process.env.QA_FIXTURE);
const proof=Buffer.from(process.env.QA_PROOF,'base64');
const db=new pg.Client({connectionString:process.env.DATABASE_URL}); await db.connect();
try {
  await db.query('begin');
  const branch=(await db.query("insert into branches(name,code) values('QA rollback only','qa-rollback') returning id")).rows[0].id;
  const role=(await db.query("insert into roles(name,is_system) values('QA rollback admin',1) returning id")).rows[0].id;
  for(const permission of ['sales.read','payments.read']) {
    await db.query('insert into permissions(key,description) values($1,$2) on conflict do nothing',[permission,'Isolated rollback fixture']);
    await db.query('insert into role_permissions(role_id,permission_key) values($1,$2)',[role,permission]);
  }
  const user=(await db.query("insert into users(name,email,password_hash,role_id,branch_id,is_cross_branch) values('QA rollback admin','rollback@example.invalid',$1,$2,$3,1) returning id",[await hashPassword(process.env.QA_PASSWORD),role,branch])).rows[0].id;
  const customer=(await db.query("insert into customers(name,branch_id) values('QA rollback customer',$1) returning id",[branch])).rows[0].id;
  await db.query("insert into orders(id,order_number,customer_id,branch_id,total_amount,status,created_by) values($1,'QA-ROLLBACK',$2,$3,'5.00','Processing',$4)",[f.orderId,customer,branch,user]);
  const product=(await db.query("insert into products(name,sku,category,unit,unit_price) values('QA rollback product','QA-ROLLBACK','QA','piece','5.00') returning id")).rows[0].id;
  await db.query('insert into order_items(order_id,product_id,quantity,unit_price,line_total) values($1,$2,1,5,5)',[f.orderId,product]);
  await db.query("insert into attachments(id,file_name,object_key,mime_type,file_size,uploaded_by,entity_type,entity_id) values($1,'qa-rollback.png',$2,'image/png',$3,$4,'payment',$5)",[f.attachmentId,'local/'+f.proofId,proof.length,user,f.paymentId]);
  await db.query("insert into payments(id,reference,order_id,method,amount,status,recorded_by,payment_proof_attachment_id) values($1,'QA-ROLLBACK-PAY',$2,'Cash','5.00','Paid',$3,$4)",[f.paymentId,f.orderId,user,f.attachmentId]);
  await writeFile('/proofs/'+f.proofId,proof,{flag:'wx',mode:0o644});
  await db.query('commit');
} finally { await db.end(); }
`
}
