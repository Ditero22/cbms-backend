export type AuthenticatedUser = {
  id: string
  name: string
  email: string
  role: string
  branchId: string | null
  branch: string
  isCrossBranch: boolean
  permissions: string[]
}
