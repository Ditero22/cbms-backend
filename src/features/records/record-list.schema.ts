import { z } from 'zod'

export const moduleListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    search: z.string().trim().max(100).default(''),
    branchId: z.union([z.uuid(), z.literal('unassigned')]).optional(),
    status: z.string().trim().min(1).max(80).optional(),
    sort: z.string().trim().min(1).max(80).optional(),
    order: z.enum(['asc', 'desc']).default('asc'),
  })
  .strict()

export type ModuleListQuery = z.infer<typeof moduleListQuerySchema>

export function getProjectedAliases(query: string) {
  return new Set(Array.from(query.matchAll(/\bas\s+"([^"]+)"/gi), (match) => match[1]))
}
