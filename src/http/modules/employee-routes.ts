import { Router } from 'express'
import {
  createEmployee,
  archiveEmployee,
  getEmployeeOptions,
  getEmployeeDetail,
  updateEmployee,
} from '@/features/employees/employee.service.js'
import {
  createEmployeeSchema,
  updateEmployeeSchema,
} from '@/features/employees/employee.schemas.js'
import { AppError } from '@/shared/errors/AppError.js'
import { z } from 'zod'

export const employeeRouter = Router()

employeeRouter.get('/employees/options', async (req, res) => {
  const user = req.user
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  res.json(await getEmployeeOptions(user))
})

employeeRouter.get('/employees/:employeeId', async (req, res) => {
  const user = req.user
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  const parsedId = z.uuid().safeParse(req.params.employeeId)
  if (!parsedId.success) {
    throw new AppError(400, 'INVALID_EMPLOYEE_ID', 'The employee ID is invalid.')
  }
  const parsedQuery = z
    .object({ historyPage: z.coerce.number().int().min(1).max(10000).optional() })
    .strict()
    .safeParse(req.query)
  if (!parsedQuery.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'The history page is invalid.')
  }
  res.json(await getEmployeeDetail(parsedId.data, user, parsedQuery.data.historyPage))
})

employeeRouter.post('/employees', async (req, res) => {
  const user = req.user
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  const parsed = createEmployeeSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the entered values.', parsed.error.flatten())
  }
  const employee = await createEmployee(parsed.data, {
    user,
    ipAddress: req.ip ?? null,
    requestId: req.requestId ?? null,
  })
  res.status(201).json(employee)
})

employeeRouter.patch('/employees/:employeeId', async (req, res) => {
  const user = req.user
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  const parsedId = z.uuid().safeParse(req.params.employeeId)
  if (!parsedId.success) {
    throw new AppError(400, 'INVALID_EMPLOYEE_ID', 'The employee ID is invalid.')
  }
  const parsed = updateEmployeeSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the entered values.', parsed.error.flatten())
  }
  const employee = await updateEmployee(parsedId.data, parsed.data, {
    user,
    ipAddress: req.ip ?? null,
    requestId: req.requestId ?? null,
  })
  res.json(employee)
})

employeeRouter.patch('/employees/:employeeId/archive', async (req, res) => {
  const user = req.user
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.')
  const parsedId = z.uuid().safeParse(req.params.employeeId)
  if (!parsedId.success) {
    throw new AppError(400, 'INVALID_EMPLOYEE_ID', 'The employee ID is invalid.')
  }

  const employee = await archiveEmployee(parsedId.data, {
    user,
    ipAddress: req.ip ?? null,
    requestId: req.requestId ?? null,
  })
  res.json(employee)
})
