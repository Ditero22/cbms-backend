import type { ModuleListQuery } from './record-list.schema.js'

export function buildListFilters(
  listQuery: ModuleListQuery,
  initialParameterCount: number,
  includeStatus: boolean,
  searchFields: string[],
) {
  const clauses: string[] = []
  const parameters: unknown[] = []

  if (listQuery.search && searchFields.length > 0) {
    parameters.push(`%${listQuery.search}%`)
    const searchableValues = searchFields
      .map((field) => `module_rows."${field.replaceAll('"', '""')}"`)
      .join(', ')
    clauses.push(
      `concat_ws(' ', ${searchableValues}) ilike $${initialParameterCount + parameters.length}`,
    )
  }

  if (includeStatus && listQuery.status) {
    parameters.push(listQuery.status)
    clauses.push(`module_rows."Status" = $${initialParameterCount + parameters.length}`)
  }

  return {
    sql: clauses.length ? ` where ${clauses.join(' and ')}` : '',
    parameters,
  }
}
