const nextDeliveryStatuses: Record<string, string[]> = {
  Preparing: ['Scheduled', 'In Transit', 'Failed'],
  Scheduled: ['In Transit', 'Failed'],
  'In Transit': ['Delivered', 'Failed'],
}

export function canTransitionDeliveryStatus(current: string, next: string) {
  return nextDeliveryStatuses[current]?.includes(next) ?? false
}
