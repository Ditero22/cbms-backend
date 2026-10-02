import { relations, sql } from 'drizzle-orm'
import {
  bigserial,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

const id = () => uuid('id').defaultRandom().primaryKey()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()

export const branches = pgTable(
  'branches',
  {
    id: id(),
    name: text('name').notNull(),
    code: text('code').notNull(),
    managerName: text('manager_name'),
    phone: text('phone'),
    email: text('email'),
    address: text('address'),
    status: text('status').notNull().default('Active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by'),
  },
  (table) => [
    uniqueIndex('branches_code_unique').on(table.code),
    index('branches_status_idx').on(table.status),
  ],
)

export const roles = pgTable('roles', {
  id: id(),
  name: text('name').notNull().unique(),
  description: text('description'),
  isSystem: integer('is_system').notNull().default(0),
  createdAt: createdAt(),
})

export const permissions = pgTable('permissions', {
  key: text('key').primaryKey(),
  description: text('description').notNull(),
})

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionKey: text('permission_key')
      .notNull()
      .references(() => permissions.key, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permissionKey] })],
)

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    isCrossBranch: integer('is_cross_branch').notNull().default(0),
    status: text('status').notNull().default('Active'),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by'),
  },
  (table) => [
    uniqueIndex('users_email_unique').on(table.email),
    index('users_branch_idx').on(table.branchId),
  ],
)

export const userSessions = pgTable(
  'user_sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
  },
  (table) => [
    index('user_sessions_expires_idx').on(table.expiresAt),
    index('user_sessions_user_idx').on(table.userId),
  ],
)

export const usedRefreshTokens = pgTable('used_refresh_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => userSessions.id, { onDelete: 'cascade' }),
  usedAt: timestamp('used_at', { withTimezone: true }).notNull().defaultNow(),
})

export const employees = pgTable(
  'employees',
  {
    id: id(),
    employeeNumber: text('employee_number').notNull(),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    address: text('address'),
    position: text('position').notNull(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    status: text('status').notNull().default('Active'),
    hiredAt: timestamp('hired_at', { withTimezone: true }),
    isDriver: integer('is_driver').notNull().default(0),
    licenseNumber: text('license_number'),
    licenseClassification: text('license_classification'),
    licenseExpiresOn: text('license_expires_on'),
    driverAvailability: text('driver_availability').notNull().default('Available'),
    emergencyContactName: text('emergency_contact_name'),
    emergencyContactPhone: text('emergency_contact_phone'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by'),
  },
  (table) => [
    uniqueIndex('employees_number_unique').on(table.employeeNumber),
    index('employees_branch_idx').on(table.branchId),
    check('employees_is_driver_valid', sql`${table.isDriver} in (0,1)`),
    check(
      'employees_driver_availability_valid',
      sql`${table.driverAvailability} in ('Available','Unavailable')`,
    ),
    check(
      'employees_license_date_valid',
      sql`${table.licenseExpiresOn} is null or (${table.licenseExpiresOn} ~ '^\\d{4}-\\d{2}-\\d{2}$' and ${table.licenseExpiresOn}::date::text=${table.licenseExpiresOn})`,
    ),
  ],
)

export const customers = pgTable(
  'customers',
  {
    id: id(),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    contactName: text('contact_name'),
    email: text('email'),
    phone: text('phone'),
    location: text('location'),
    status: text('status').notNull().default('Active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by'),
  },
  (table) => [
    index('customers_name_idx').on(table.name),
    index('customers_branch_name_idx').on(table.branchId, table.name),
  ],
)

export const suppliers = pgTable(
  'suppliers',
  {
    id: id(),
    name: text('name').notNull(),
    contactName: text('contact_name'),
    email: text('email'),
    phone: text('phone'),
    category: text('category'),
    paymentTerms: text('payment_terms'),
    status: text('status').notNull().default('Active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by'),
  },
  (table) => [index('suppliers_name_idx').on(table.name)],
)

export const products = pgTable(
  'products',
  {
    id: id(),
    name: text('name').notNull(),
    sku: text('sku').notNull(),
    category: text('category').notNull(),
    unit: text('unit').notNull(),
    description: text('description'),
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
    supplierId: uuid('supplier_id').references(() => suppliers.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('Active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by'),
  },
  (table) => [
    uniqueIndex('products_sku_unique').on(table.sku),
    index('products_category_idx').on(table.category),
  ],
)

export const inventory = pgTable(
  'inventory',
  {
    id: id(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull().default('0'),
    reservedQuantity: numeric('reserved_quantity', { precision: 14, scale: 3 })
      .notNull()
      .default('0'),
    reorderLevel: numeric('reorder_level', { precision: 14, scale: 3 }).notNull().default('0'),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('inventory_product_branch_unique').on(table.productId, table.branchId),
    index('inventory_branch_idx').on(table.branchId),
    check('inventory_quantity_nonnegative', sql`${table.quantity} >= 0`),
    check('inventory_reserved_nonnegative', sql`${table.reservedQuantity} >= 0`),
    check(
      'inventory_reserved_not_above_quantity',
      sql`${table.reservedQuantity} <= ${table.quantity}`,
    ),
    check('inventory_reorder_nonnegative', sql`${table.reorderLevel} >= 0`),
  ],
)

export const inventoryTransactions = pgTable(
  'inventory_transactions',
  {
    id: id(),
    ledgerSequence: bigserial('ledger_sequence', { mode: 'bigint' }).notNull(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    transactionType: text('transaction_type').notNull(),
    requestKey: text('request_key').unique(),
    quantityDelta: numeric('quantity_delta', { precision: 14, scale: 3 }).notNull(),
    referenceType: text('reference_type'),
    referenceId: uuid('reference_id'),
    note: text('note'),
    performedBy: uuid('performed_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [
    index('inventory_transactions_product_branch_idx').on(table.productId, table.branchId),
    uniqueIndex('inventory_transactions_ledger_sequence_unique').on(table.ledgerSequence),
    index('inventory_transactions_stock_sequence_idx').on(
      table.productId,
      table.branchId,
      table.ledgerSequence,
    ),
    index('inventory_transactions_created_idx').on(table.createdAt),
    index('inventory_transactions_stock_ledger_idx').on(
      table.productId,
      table.branchId,
      table.createdAt,
      table.id,
    ),
  ],
)

export const orders = pgTable(
  'orders',
  {
    id: id(),
    orderNumber: text('order_number').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    status: text('status').notNull().default('Pending'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    requestKey: uuid('request_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => users.id),
    cancellationReason: text('cancellation_reason'),
    cancellationNotes: text('cancellation_notes'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: uuid('completed_by').references(() => users.id),
    stockMode: text('stock_mode').notNull().default('Reserved'),
  },
  (table) => [
    uniqueIndex('orders_number_unique').on(table.orderNumber),
    uniqueIndex('orders_request_key_unique').on(table.requestKey),
    index('orders_branch_created_idx').on(table.branchId, table.createdAt),
    index('orders_status_idx').on(table.status),
    check('orders_stock_mode_valid', sql`${table.stockMode} in ('Reserved', 'LegacyConsumed')`),
  ],
)

export const orderItems = pgTable(
  'order_items',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    cancelledQuantity: numeric('cancelled_quantity', { precision: 14, scale: 3 })
      .notNull()
      .default('0'),
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
    lineTotal: numeric('line_total', { precision: 14, scale: 2 }).notNull(),
  },
  (table) => [
    check('order_items_quantity_positive', sql`${table.quantity} > 0`),
    check(
      'order_items_cancelled_quantity_valid',
      sql`${table.cancelledQuantity} >= 0 and ${table.cancelledQuantity} <= ${table.quantity}`,
    ),
  ],
)

export const orderReservations = pgTable(
  'order_reservations',
  {
    id: id(),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    fulfilledQuantity: numeric('fulfilled_quantity', { precision: 14, scale: 3 })
      .notNull()
      .default('0'),
    releasedQuantity: numeric('released_quantity', { precision: 14, scale: 3 })
      .notNull()
      .default('0'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [
    index('order_reservations_order_item_idx').on(table.orderItemId),
    check('order_reservations_quantity_positive', sql`${table.quantity} > 0`),
    check('order_reservations_fulfilled_nonnegative', sql`${table.fulfilledQuantity} >= 0`),
    check('order_reservations_released_nonnegative', sql`${table.releasedQuantity} >= 0`),
    check(
      'order_reservations_accounted_quantity_valid',
      sql`${table.fulfilledQuantity} + ${table.releasedQuantity} <= ${table.quantity}`,
    ),
  ],
)

export const payments = pgTable(
  'payments',
  {
    id: id(),
    reference: text('reference').notNull().unique(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    method: text('method').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    status: text('status').notNull().default('Paid'),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => users.id),
    paymentDate: date('payment_date')
      .notNull()
      .default(sql`(now() at time zone 'Asia/Manila')::date`),
    externalReference: text('external_reference'),
    notes: text('notes'),
    requestKey: text('request_key').unique(),
    requestFingerprint: text('request_fingerprint'),
    paymentProofAttachmentId: uuid('payment_proof_attachment_id').references(() => attachments.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAt(),
  },
  (table) => [
    check('payments_amount_positive', sql`${table.amount} > 0`),
    check(
      'payments_request_fingerprint_valid',
      sql`${table.requestFingerprint} is null or ${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    index('payments_order_date_idx').on(table.orderId, table.paymentDate),
  ],
)

export const paymentRefunds = pgTable(
  'payment_refunds',
  {
    id: id(),
    reference: text('reference').notNull().unique(),
    requestKey: text('request_key').notNull().unique(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    method: text('method').notNull(),
    reason: text('reason').notNull(),
    notes: text('notes'),
    status: text('status').notNull().default('Requested'),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    approvedBy: uuid('approved_by').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    processedBy: uuid('processed_by').references(() => users.id),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    processedReference: text('processed_reference'),
  },
  (table) => [
    index('payment_refunds_order_created_idx').on(table.orderId, table.requestedAt),
    index('payment_refunds_payment_status_idx').on(table.paymentId, table.status),
    check('payment_refunds_amount_positive', sql`${table.amount} > 0`),
    check(
      'payment_refunds_status_valid',
      sql`${table.status} in ('Requested', 'Approved', 'Processed', 'Rejected')`,
    ),
  ],
)

export const transfers = pgTable(
  'inventory_transfers',
  {
    id: id(),
    reference: text('reference').notNull().unique(),
    fromBranchId: uuid('from_branch_id')
      .notNull()
      .references(() => branches.id),
    toBranchId: uuid('to_branch_id')
      .notNull()
      .references(() => branches.id),
    status: text('status').notNull().default('Pending'),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    note: text('note'),
    requestKey: uuid('request_key').unique(),
  },
  (table) => [
    check(
      'inventory_transfers_distinct_branches',
      sql`${table.fromBranchId} <> ${table.toBranchId}`,
    ),
  ],
)

export const transferItems = pgTable('inventory_transfer_items', {
  id: id(),
  transferId: uuid('transfer_id')
    .notNull()
    .references(() => transfers.id, { onDelete: 'cascade' }),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id),
  quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
})

export const vehicles = pgTable(
  'vehicles',
  {
    id: id(),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    plateNumber: text('plate_number').notNull().unique(),
    vehicleType: text('vehicle_type').notNull(),
    assignedDriver: text('assigned_driver'),
    brand: text('brand'),
    model: text('model'),
    year: integer('year'),
    color: text('color'),
    fuelType: text('fuel_type'),
    odometer: numeric('odometer', { precision: 14, scale: 3 }),
    capacityValue: numeric('capacity_value', { precision: 14, scale: 3 }),
    capacityUnit: text('capacity_unit'),
    defaultDriverId: uuid('default_driver_id').references(() => employees.id),
    registrationExpiresOn: text('registration_expires_on'),
    insuranceProvider: text('insurance_provider'),
    insuranceReference: text('insurance_reference'),
    insuranceExpiresOn: text('insurance_expires_on'),
    manualStatus: text('manual_status'),
    notes: text('notes'),
    nextServiceAt: timestamp('next_service_at', { withTimezone: true }),
    status: text('status').notNull().default('Available'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by'),
  },
  (table) => [
    index('vehicles_branch_idx').on(table.branchId),
    check(
      'vehicles_capacity_valid',
      sql`(${table.capacityValue} is null and ${table.capacityUnit} is null) or (${table.capacityValue} is not null and ${table.capacityUnit} is not null and ${table.capacityValue} > 0 and length(trim(${table.capacityUnit})) > 0)`,
    ),
    check('vehicles_odometer_valid', sql`${table.odometer} is null or ${table.odometer} >= 0`),
    check(
      'vehicles_manual_status_valid',
      sql`${table.manualStatus} is null or ${table.manualStatus} in ('Unavailable','Under Maintenance')`,
    ),
    check(
      'vehicles_dates_valid',
      sql`(${table.registrationExpiresOn} is null or (${table.registrationExpiresOn} ~ '^\\d{4}-\\d{2}-\\d{2}$' and ${table.registrationExpiresOn}::date::text=${table.registrationExpiresOn})) and (${table.insuranceExpiresOn} is null or (${table.insuranceExpiresOn} ~ '^\\d{4}-\\d{2}-\\d{2}$' and ${table.insuranceExpiresOn}::date::text=${table.insuranceExpiresOn}))`,
    ),
  ],
)

export const deliveries = pgTable(
  'deliveries',
  {
    id: id(),
    reference: text('reference').notNull().unique(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    destination: text('destination').notNull(),
    driverName: text('driver_name'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    status: text('status').notNull().default('Preparing'),
    allocationOrigin: text('allocation_origin').notNull().default('Recorded'),
    allocationStatus: text('allocation_status').notNull().default('Verified'),
    allocationVerifiedAt: timestamp('allocation_verified_at', { withTimezone: true }),
    allocationVerifiedBy: uuid('allocation_verified_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      'deliveries_allocation_origin_valid',
      sql`${table.allocationOrigin} in ('Recorded', 'LegacyBackfill')`,
    ),
    check(
      'deliveries_allocation_status_valid',
      sql`${table.allocationStatus} in ('Verified', 'Unverified')`,
    ),
  ],
)

export const deliveryItems = pgTable(
  'delivery_items',
  {
    id: id(),
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => deliveries.id),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id),
    reservationId: uuid('reservation_id').references(() => orderReservations.id),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    inferredQuantity: numeric('inferred_quantity', { precision: 14, scale: 3 }),
  },
  (table) => [
    index('delivery_items_delivery_idx').on(table.deliveryId),
    index('delivery_items_order_item_idx').on(table.orderItemId),
    index('delivery_items_reservation_idx').on(table.reservationId),
    check('delivery_items_quantity_positive', sql`${table.quantity} > 0`),
  ],
)

export const orderReturns = pgTable(
  'order_returns',
  {
    id: id(),
    reference: text('reference').notNull().unique(),
    requestKey: text('request_key').notNull().unique(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => deliveries.id),
    reason: text('reason').notNull(),
    notes: text('notes'),
    status: text('status').notNull().default('Requested'),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    approvedBy: uuid('approved_by').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    receivedBy: uuid('received_by').references(() => users.id),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    rejectedBy: uuid('rejected_by').references(() => users.id),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    rejectionNotes: text('rejection_notes'),
  },
  (table) => [
    index('order_returns_order_created_idx').on(table.orderId, table.requestedAt),
    index('order_returns_delivery_status_idx').on(table.deliveryId, table.status),
    check(
      'order_returns_status_valid',
      sql`${table.status} in ('Requested', 'Approved', 'Received', 'Rejected')`,
    ),
  ],
)

export const orderReturnItems = pgTable(
  'order_return_items',
  {
    id: id(),
    returnId: uuid('return_id')
      .notNull()
      .references(() => orderReturns.id),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    condition: text('condition').notNull(),
    remainderCondition: text('remainder_condition'),
    acceptedQuantity: numeric('accepted_quantity', { precision: 14, scale: 3 })
      .notNull()
      .default('0'),
  },
  (table) => [
    uniqueIndex('order_return_items_return_order_item_unique').on(
      table.returnId,
      table.orderItemId,
    ),
    index('order_return_items_order_item_idx').on(table.orderItemId),
    check('order_return_items_quantity_positive', sql`${table.quantity} > 0`),
    check(
      'order_return_items_condition_valid',
      sql`${table.condition} in ('Resalable', 'Damaged', 'Defective', 'Used', 'Lost', 'Non-returnable')`,
    ),
    check(
      'order_return_items_accepted_quantity_valid',
      sql`${table.acceptedQuantity} >= 0 and ${table.acceptedQuantity} <= ${table.quantity}`,
    ),
    check(
      'order_return_items_non_resalable_not_restocked',
      sql`${table.condition} = 'Resalable' or ${table.acceptedQuantity} = 0`,
    ),
    check(
      'order_return_items_remainder_condition_valid',
      sql`${table.remainderCondition} is null or (${table.condition} = 'Resalable' and ${table.acceptedQuantity} < ${table.quantity} and ${table.remainderCondition} in ('Damaged', 'Defective', 'Used', 'Lost', 'Non-returnable'))`,
    ),
  ],
)

export const expenses = pgTable(
  'expenses',
  {
    id: id(),
    description: text('description').notNull(),
    category: text('category').notNull(),
    requestKey: text('request_key').unique(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    submittedBy: uuid('submitted_by')
      .notNull()
      .references(() => users.id),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    status: text('status').notNull().default('Pending'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    approvedBy: uuid('approved_by').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
  },
  (table) => [
    index('expenses_branch_created_idx').on(table.branchId, table.createdAt),
    check('expenses_amount_positive', sql`${table.amount} > 0`),
  ],
)

export const payrollRuns = pgTable(
  'payroll_runs',
  {
    id: id(),
    reference: text('reference').notNull().unique(),
    requestKey: uuid('request_key'),
    requestUserId: uuid('request_user_id').references(() => users.id),
    requestFingerprint: text('request_fingerprint'),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    employeeCount: integer('employee_count').notNull().default(0),
    grossPay: numeric('gross_pay', { precision: 14, scale: 2 }).notNull().default('0'),
    branchId: uuid('branch_id').references(() => branches.id),
    status: text('status').notNull().default('Draft'),
    processedBy: uuid('processed_by').references(() => users.id),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('payroll_runs_request_key_unique').on(table.requestKey),
    check(
      'payroll_runs_request_identity_valid',
      sql`(${table.requestKey} is null and ${table.requestUserId} is null and ${table.requestFingerprint} is null)
      or (${table.requestKey} is not null and ${table.requestUserId} is not null and ${table.requestFingerprint} ~ '^[0-9a-f]{64}$')`,
    ),
  ],
)

export const payrollEntries = pgTable(
  'payroll_entries',
  {
    id: id(),
    payrollRunId: uuid('payroll_run_id')
      .notNull()
      .references(() => payrollRuns.id),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    employeeNumber: text('employee_number').notNull(),
    employeeName: text('employee_name').notNull(),
    position: text('position').notNull(),
    payBasis: text('pay_basis').notNull(),
    units: numeric('units', { precision: 12, scale: 3 }).notNull(),
    rate: numeric('rate', { precision: 14, scale: 2 }).notNull(),
    regularPay: numeric('regular_pay', { precision: 14, scale: 2 }).notNull(),
    additionalPay: numeric('additional_pay', { precision: 14, scale: 2 }).notNull().default('0'),
    deductions: numeric('deductions', { precision: 14, scale: 2 }).notNull().default('0'),
    grossPay: numeric('gross_pay', { precision: 14, scale: 2 }).notNull(),
    netPay: numeric('net_pay', { precision: 14, scale: 2 }).notNull(),
    paymentStatus: text('payment_status').notNull().default('Pending'),
    paymentDate: date('payment_date'),
    paymentMethod: text('payment_method'),
    paymentReference: text('payment_reference'),
    paymentNotes: text('payment_notes'),
    paymentRequestKey: uuid('payment_request_key'),
    paymentRequestFingerprint: text('payment_request_fingerprint'),
    paymentProofAttachmentId: uuid('payment_proof_attachment_id').references(() => attachments.id, {
      onDelete: 'restrict',
    }),
    paidBy: uuid('paid_by').references(() => users.id),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    confirmedBy: uuid('confirmed_by').references(() => users.id),
    acknowledgement: text('acknowledgement'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('payroll_entries_run_employee_unique').on(table.payrollRunId, table.employeeId),
    uniqueIndex('payroll_entries_payment_request_key_unique').on(table.paymentRequestKey),
    index('payroll_entries_branch_created_idx').on(table.branchId, table.createdAt),
    index('payroll_entries_run_name_idx').on(table.payrollRunId, table.employeeName),
    check(
      'payroll_entries_basis_valid',
      sql`${table.payBasis} in ('Salary', 'Daily wage', 'Weekly wage', 'Per-trip pay', 'Other')`,
    ),
    check('payroll_entries_units_valid', sql`${table.units} > 0`),
    check('payroll_entries_rate_valid', sql`${table.rate} > 0`),
    check(
      'payroll_entries_totals_valid',
      sql`${table.regularPay} >= 0 and ${table.additionalPay} >= 0 and ${table.deductions} >= 0 and ${table.grossPay} = ${table.regularPay} + ${table.additionalPay} and ${table.netPay} = ${table.grossPay} - ${table.deductions} and ${table.netPay} >= 0`,
    ),
    check(
      'payroll_entries_payment_status_valid',
      sql`${table.paymentStatus} in ('Pending', 'Paid', 'Received')`,
    ),
    check(
      'payroll_entries_payment_request_identity_valid',
      sql`(${table.paymentRequestKey} is null and ${table.paymentRequestFingerprint} is null)
      or (${table.paymentRequestKey} is not null and ${table.paymentRequestFingerprint} is not null and ${table.paymentRequestFingerprint} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      'payroll_entries_payment_fields_valid',
      sql`(${table.paymentStatus} = 'Pending' and ${table.paymentDate} is null and ${table.paymentMethod} is null and ${table.paidBy} is null and ${table.paidAt} is null and ${table.receivedAt} is null and ${table.confirmedBy} is null) or (${table.paymentStatus} = 'Paid' and ${table.paymentDate} is not null and ${table.paymentMethod} is not null and ${table.paidBy} is not null and ${table.paidAt} is not null and ${table.receivedAt} is null and ${table.confirmedBy} is null) or (${table.paymentStatus} = 'Received' and ${table.paymentDate} is not null and ${table.paymentMethod} is not null and ${table.paidBy} is not null and ${table.paidAt} is not null and ${table.receivedAt} is not null and ${table.confirmedBy} is not null)`,
    ),
  ],
)

export const payrollEntryAdjustments = pgTable(
  'payroll_entry_adjustments',
  {
    id: id(),
    payrollEntryId: uuid('payroll_entry_id')
      .notNull()
      .references(() => payrollEntries.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    type: text('type').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    notes: text('notes'),
    createdAt: createdAt(),
  },
  (table) => [
    index('payroll_entry_adjustments_entry_idx').on(table.payrollEntryId, table.createdAt),
    check('payroll_entry_adjustments_amount_valid', sql`${table.amount} > 0`),
    check(
      'payroll_entry_adjustments_type_valid',
      sql`(${table.kind} = 'earning' and ${table.type} in ('Overtime', 'Bonus', 'Allowance', 'Reimbursement', 'Other compensation')) or (${table.kind} = 'deduction' and ${table.type} in ('Deduction', 'Cash advance recovery'))`,
    ),
  ],
)

export const attachments = pgTable(
  'attachments',
  {
    id: id(),
    fileName: text('file_name').notNull(),
    objectKey: text('object_key').notNull().unique(),
    mimeType: text('mime_type').notNull(),
    fileSize: integer('file_size').notNull(),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check('attachments_file_size_positive', sql`${table.fileSize} > 0`),
    index('attachments_entity_created_idx').on(table.entityType, table.entityId, table.createdAt),
  ],
)

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    branchId: uuid('branch_id').references(() => branches.id),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),
    ipAddress: text('ip_address'),
    requestId: text('request_id'),
    createdAt: createdAt(),
  },
  (table) => [
    index('audit_logs_created_idx').on(table.createdAt),
    index('audit_logs_branch_idx').on(table.branchId),
    index('audit_logs_entity_history_idx').on(table.entityType, table.entityId, table.createdAt),
  ],
)

export const vehicleAssignments = pgTable(
  'vehicle_assignments',
  {
    id: id(),
    reference: text('reference').notNull().unique(),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    driverId: uuid('driver_id')
      .notNull()
      .references(() => employees.id),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    deliveryId: uuid('delivery_id').references(() => deliveries.id),
    destination: text('destination').notNull(),
    purpose: text('purpose').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    startOdometer: numeric('start_odometer', { precision: 14, scale: 3 }),
    endOdometer: numeric('end_odometer', { precision: 14, scale: 3 }),
    status: text('status').notNull().default('Scheduled'),
    notes: text('notes'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('vehicle_assignments_live_vehicle_unique')
      .on(table.vehicleId)
      .where(sql`${table.status} in ('Scheduled', 'Active')`),
    uniqueIndex('vehicle_assignments_live_driver_unique')
      .on(table.driverId)
      .where(sql`${table.status} in ('Scheduled', 'Active')`),
    uniqueIndex('vehicle_assignments_live_delivery_unique')
      .on(table.deliveryId)
      .where(sql`${table.status} in ('Scheduled', 'Active')`),
    index('vehicle_assignments_branch_created_idx').on(table.branchId, table.createdAt),
    check(
      'vehicle_assignments_status_valid',
      sql`${table.status} in ('Scheduled', 'Active', 'Completed', 'Cancelled')`,
    ),
    check(
      'vehicle_assignments_odometer_valid',
      sql`(${table.startOdometer} is null or ${table.startOdometer} >= 0) and (${table.endOdometer} is null or ${table.endOdometer} >= coalesce(${table.startOdometer}, 0))`,
    ),
  ],
)

export const vehicleMaintenance = pgTable(
  'vehicle_maintenance',
  {
    id: id(),
    reference: text('reference').notNull().unique(),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    maintenanceType: text('maintenance_type').notNull(),
    description: text('description').notNull(),
    problemReported: text('problem_reported'),
    startedOn: text('started_on'),
    completedOn: text('completed_on'),
    serviceProvider: text('service_provider'),
    contactPerson: text('contact_person'),
    laborCost: numeric('labor_cost', { precision: 14, scale: 2 }).notNull().default('0'),
    partsCost: numeric('parts_cost', { precision: 14, scale: 2 }).notNull().default('0'),
    otherCost: numeric('other_cost', { precision: 14, scale: 2 }).notNull().default('0'),
    receiptReference: text('receipt_reference'),
    notes: text('notes'),
    status: text('status').notNull().default('Scheduled'),
    expenseId: uuid('expense_id')
      .references(() => expenses.id)
      .unique(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('vehicle_maintenance_vehicle_created_idx').on(table.vehicleId, table.createdAt),
    index('vehicle_maintenance_branch_created_idx').on(table.branchId, table.createdAt),
    check(
      'vehicle_maintenance_status_valid',
      sql`${table.status} in ('Scheduled', 'In Progress', 'Completed', 'Cancelled')`,
    ),
    check(
      'vehicle_maintenance_cost_valid',
      sql`${table.laborCost} >= 0 and ${table.partsCost} >= 0 and ${table.otherCost} >= 0 and ${table.laborCost} + ${table.partsCost} + ${table.otherCost} <= 999999999999.99`,
    ),
    check(
      'vehicle_maintenance_dates_valid',
      sql`(${table.startedOn} is null or (${table.startedOn} ~ '^\\d{4}-\\d{2}-\\d{2}$' and ${table.startedOn}::date::text=${table.startedOn})) and (${table.completedOn} is null or (${table.completedOn} ~ '^\\d{4}-\\d{2}-\\d{2}$' and ${table.completedOn}::date::text=${table.completedOn})) and (${table.completedOn} is null or ${table.startedOn} is null or ${table.completedOn} >= ${table.startedOn})`,
    ),
  ],
)

export const driverAllowances = pgTable(
  'driver_allowances',
  {
    id: id(),
    reference: text('reference').notNull().unique(),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => employees.id),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    assignmentId: uuid('assignment_id').references(() => vehicleAssignments.id),
    deliveryId: uuid('delivery_id').references(() => deliveries.id),
    paymentType: text('payment_type').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    paymentTiming: text('payment_timing').notNull(),
    method: text('method').notNull(),
    referenceNumber: text('reference_number'),
    notes: text('notes'),
    status: text('status').notNull().default('Pending'),
    authorizedBy: uuid('authorized_by').references(() => users.id),
    authorizedAt: timestamp('authorized_at', { withTimezone: true }),
    releasedBy: uuid('released_by').references(() => users.id),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    confirmedBy: uuid('confirmed_by').references(() => users.id),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    acknowledgement: text('acknowledgement'),
    expenseId: uuid('expense_id')
      .references(() => expenses.id)
      .unique(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('driver_allowances_branch_created_idx').on(table.branchId, table.createdAt),
    check('driver_allowances_amount_valid', sql`${table.amount} > 0`),
    check(
      'driver_allowances_status_valid',
      sql`${table.status} in ('Pending', 'Approved', 'Released', 'Received', 'Cancelled')`,
    ),
  ],
)

export const branchRelations = relations(branches, ({ many }) => ({
  employees: many(employees),
  inventory: many(inventory),
  orders: many(orders),
}))
export const userRelations = relations(users, ({ one, many }) => ({
  role: one(roles, { fields: [users.roleId], references: [roles.id] }),
  sessions: many(userSessions),
}))
