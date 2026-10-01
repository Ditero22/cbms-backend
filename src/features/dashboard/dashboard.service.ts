import type { AuthenticatedUser } from '@/shared/types/auth.js'
import { getAssignedBranchScope } from '@/shared/security/branch-scope.js'
import * as dashboardRepository from './dashboard.repository.js'
import { getCustomerBalanceSummary } from '@/features/payments/payment-balances.repository.js'

export async function getDashboardSummary(user: AuthenticatedUser) {
  const canReadSales = user.permissions.includes('sales.read')
  const canReadInventory = user.permissions.includes('inventory.read')
  const canReadEmployees = user.permissions.includes('employees.read')
  const canReadExpenses = user.permissions.includes('expenses.read')
  const canReadFleet = user.permissions.includes('vehicles.read')
  const canReadMaintenance = user.permissions.includes('vehicles.maintenance') && canReadExpenses
  const canReadAllowances = user.permissions.includes('driver-allowances.read')
  const canReadPayments = user.permissions.includes('payments.read')

  const salesBranch = canReadSales ? (getAssignedBranchScope(user) ?? null) : null
  const inventoryBranch = canReadInventory ? (getAssignedBranchScope(user) ?? null) : null
  const employeeBranch = canReadEmployees ? (getAssignedBranchScope(user) ?? null) : null
  const expenseBranch = canReadExpenses ? (getAssignedBranchScope(user) ?? null) : null
  const fleetBranch = canReadFleet ? (getAssignedBranchScope(user) ?? null) : null

  const [
    sales,
    branchSales,
    recentOrders,
    stockAlerts,
    inventoryTasks,
    activeEmployees,
    expenseTasks,
  ] = await Promise.all([
    canReadSales ? dashboardRepository.getSalesSummary(salesBranch) : null,
    canReadSales ? dashboardRepository.getBranchSales(salesBranch) : [],
    canReadSales ? dashboardRepository.getRecentOrders(salesBranch) : [],
    canReadInventory ? dashboardRepository.getInventorySummary(inventoryBranch) : 0,
    canReadInventory ? dashboardRepository.getInventoryTasks(inventoryBranch) : [],
    canReadEmployees ? dashboardRepository.getActiveEmployeeCount(employeeBranch) : 0,
    canReadExpenses ? dashboardRepository.getExpenseTasks(expenseBranch) : [],
  ])

  const [fleet, maintenanceMonthlyCost, pendingAllowances, customerBalances] = await Promise.all([
    canReadFleet ? dashboardRepository.getFleetAvailability(fleetBranch) : null,
    canReadMaintenance
      ? dashboardRepository.getMonthlyMaintenanceCost(getAssignedBranchScope(user) ?? null)
      : null,
    canReadAllowances
      ? dashboardRepository.getPendingAllowances(getAssignedBranchScope(user) ?? null)
      : null,
    canReadPayments ? getCustomerBalanceSummary(getAssignedBranchScope(user) ?? null) : null,
  ])

  return {
    stats: {
      salesTotal: sales?.salesTotal ?? '0',
      openOrders: sales?.openOrders ?? 0,
      stockAlerts,
      activeEmployees,
    },
    branchSales,
    operations: { fleet, maintenanceMonthlyCost, pendingAllowances, customerBalances },
    recentOrders,
    priorityTasks: [
      ...inventoryTasks.map((task) => ({ ...task, type: 'inventory' as const })),
      ...expenseTasks.map((task) => ({ ...task, type: 'expense' as const })),
    ].slice(0, 4),
  }
}
