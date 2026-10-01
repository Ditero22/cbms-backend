import { Router } from 'express'
import { authenticate } from './auth.js'
import { attachmentRouter } from './modules/attachment-routes.js'
import { expenseRouter } from './modules/expense-routes.js'
import { employeeRouter } from './modules/employee-routes.js'
import { deliveryRouter } from './modules/delivery-routes.js'
import { dashboardRouter } from './modules/dashboard-routes.js'
import { genericRecordRouter } from './modules/generic-record-routes.js'
import { inventoryRouter } from './modules/inventory-routes.js'
import { orderRouter } from './modules/order-routes.js'
import { paymentRouter } from './modules/payment-routes.js'
import { transferRouter } from './modules/transfer-routes.js'
import { userManagementRouter } from './modules/user-management-routes.js'
import { reportRouter } from './modules/report-routes.js'
import { orderWorkflowRouter } from './modules/order-workflow-routes.js'
import { legacyDeliveryRouter } from './modules/legacy-delivery-routes.js'
import { fleetRouter } from './modules/fleet-routes.js'
import { payrollRouter } from './modules/payroll-routes.js'

export const moduleRouter = Router()

moduleRouter.use(authenticate)
moduleRouter.use(
  attachmentRouter,
  inventoryRouter,
  dashboardRouter,
  transferRouter,
  userManagementRouter,
  orderRouter,
  paymentRouter,
  orderWorkflowRouter,
  legacyDeliveryRouter,
  deliveryRouter,
  employeeRouter,
  expenseRouter,
  reportRouter,
  fleetRouter,
  payrollRouter,
  genericRecordRouter,
)
