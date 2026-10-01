import { Router } from 'express'
import type { Request } from 'express'
import { z } from 'zod'
import { AppError } from '@/shared/errors/AppError.js'
import type { FleetContext } from '@/features/fleet/fleet.repository.js'
import * as schemas from '@/features/fleet/fleet.schemas.js'
import { fleetOptions } from '@/features/fleet/fleet-options.repository.js'
import { listFleetRecords } from '@/features/fleet/fleet-list.repository.js'
import {
  createVehicle,
  updateVehicle,
  getVehicleDetail,
  changeVehicleStatus,
  archiveVehicle,
} from '@/features/fleet/vehicle.service.js'
import {
  createMaintenance,
  updateMaintenance,
  getMaintenanceDetail,
  transitionMaintenance,
} from '@/features/fleet/maintenance.service.js'
import {
  createAssignment,
  getAssignmentDetail,
  transitionAssignment,
} from '@/features/fleet/assignment.service.js'
import {
  createAllowance,
  updateAllowance,
  getAllowanceDetail,
  transitionAllowance,
} from '@/features/fleet/allowance.service.js'

export const fleetRouter = Router()
function context(req: Request): FleetContext {
  if (!req.user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  return { user: req.user, ipAddress: req.ip ?? null, requestId: req.requestId ?? null }
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success)
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the entered values.', parsed.error.flatten())
  return parsed.data
}
const id = (req: Request) => parse(z.uuid(), req.params.id)
const historyPage = (req: Request) =>
  parse(
    z.object({ historyPage: z.coerce.number().int().min(1).max(10000).default(1) }).strict(),
    req.query,
  ).historyPage

fleetRouter.get('/vehicles/options', async (req, res) =>
  res.json(await fleetOptions(context(req).user)),
)
fleetRouter.get('/driver-allowances/options', async (req, res) =>
  res.json(await fleetOptions(context(req).user, true)),
)
for (const moduleId of ['vehicles', 'vehicle-assignments', 'driver-allowances'])
  fleetRouter.get(`/${moduleId}`, async (req, res) =>
    res.json(await listFleetRecords(moduleId, req.query, context(req).user)),
  )
fleetRouter.post('/vehicles', async (req, res) =>
  res.status(201).json(await createVehicle(parse(schemas.vehicleSchema, req.body), context(req))),
)
fleetRouter.get('/vehicles/:id', async (req, res) => {
  const page = z.coerce.number().int().min(1).max(10000).default(1)
  const pages = parse(
    z.object({ historyPage: page, maintenancePage: page, assignmentPage: page }).strict(),
    req.query,
  )
  res.json(await getVehicleDetail(id(req), context(req).user, pages.historyPage, pages))
})
fleetRouter.patch('/vehicles/:id/status', async (req, res) =>
  res.json(
    await changeVehicleStatus(
      id(req),
      parse(schemas.vehicleStatusSchema, req.body).status,
      context(req),
    ),
  ),
)
fleetRouter.patch('/vehicles/:id/archive', async (req, res) => {
  parse(z.object({}).strict(), req.body ?? {})
  res.json(await archiveVehicle(id(req), context(req)))
})
fleetRouter.patch('/vehicles/:id', async (req, res) =>
  res.json(
    await updateVehicle(id(req), parse(schemas.updateVehicleSchema, req.body), context(req)),
  ),
)
fleetRouter.post('/vehicles/:id/maintenance', async (req, res) =>
  res
    .status(201)
    .json(
      await createMaintenance(id(req), parse(schemas.maintenanceSchema, req.body), context(req)),
    ),
)
fleetRouter.get('/vehicle-maintenance/:id', async (req, res) =>
  res.json(await getMaintenanceDetail(id(req), context(req).user, historyPage(req))),
)
fleetRouter.patch('/vehicle-maintenance/:id', async (req, res) =>
  res.json(
    await updateMaintenance(
      id(req),
      parse(schemas.updateMaintenanceSchema, req.body),
      context(req),
    ),
  ),
)
fleetRouter.post('/vehicle-maintenance/:id/:action', async (req, res) =>
  res.json(
    await transitionMaintenance(
      id(req),
      parse(z.enum(['start', 'complete', 'cancel']), req.params.action),
      parse(schemas.maintenanceActionSchema, req.body ?? {}),
      context(req),
    ),
  ),
)
fleetRouter.post('/vehicle-assignments', async (req, res) =>
  res
    .status(201)
    .json(await createAssignment(parse(schemas.assignmentSchema, req.body), context(req))),
)
fleetRouter.get('/vehicle-assignments/:id', async (req, res) =>
  res.json(await getAssignmentDetail(id(req), context(req).user, historyPage(req))),
)
fleetRouter.post('/vehicle-assignments/:id/:action', async (req, res) =>
  res.json(
    await transitionAssignment(
      id(req),
      parse(z.enum(['start', 'complete', 'cancel']), req.params.action),
      parse(schemas.assignmentActionSchema, req.body ?? {}),
      context(req),
    ),
  ),
)
fleetRouter.post('/driver-allowances', async (req, res) =>
  res.status(410).json(await createAllowance({}, context(req))),
)
fleetRouter.get('/driver-allowances/:id', async (req, res) =>
  res.json(await getAllowanceDetail(id(req), context(req).user, historyPage(req))),
)
fleetRouter.patch('/driver-allowances/:id', async (req, res) =>
  res.json(
    await updateAllowance(id(req), parse(schemas.updateAllowanceSchema, req.body), context(req)),
  ),
)
fleetRouter.post('/driver-allowances/:id/:action', async (req, res) => {
  const action = parse(z.enum(['approve', 'release', 'receive', 'cancel']), req.params.action)
  res.json(
    await transitionAllowance(
      id(req),
      action,
      action === 'receive'
        ? parse(schemas.receiveAllowanceSchema, req.body)
        : parse(z.object({}).strict(), req.body ?? {}),
      context(req),
    ),
  )
})
