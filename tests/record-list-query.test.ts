import { describe, expect, it } from 'vitest'
import { buildListFilters } from '@/features/records/record-list.query.js'
import { moduleListQuerySchema } from '@/features/records/record-list.schema.js'

describe('module list SQL filters', () => {
  it('uses allowlisted output fields and bound search/status values', () => {
    const query = moduleListQuerySchema.parse({
      search: "%'; drop table users; --",
      status: 'Active',
    })

    expect(buildListFilters(query, 1, true, ['Name', 'Role'])).toEqual({
      sql: ` where concat_ws(' ', module_rows."Name", module_rows."Role") ilike $2 and module_rows."Status" = $3`,
      parameters: ["%%'; drop table users; --%", 'Active'],
    })
  })

  it('omits status filtering when building available status options', () => {
    const query = moduleListQuerySchema.parse({ search: 'order', status: 'Completed' })

    expect(buildListFilters(query, 0, false, ['Order'])).toEqual({
      sql: ` where concat_ws(' ', module_rows."Order") ilike $1`,
      parameters: ['%order%'],
    })
  })
})
