import os from 'node:os'

if (process.platform === 'win32') {
  const originalUserInfo = os.userInfo.bind(os)
  os.userInfo = (options) => {
    try {
      return originalUserInfo(options)
    } catch {
      return {
        uid: -1,
        gid: -1,
        username: process.env.USERNAME || 'cbms',
        homedir: process.env.USERPROFILE || process.cwd(),
        shell: null,
      }
    }
  }
}
