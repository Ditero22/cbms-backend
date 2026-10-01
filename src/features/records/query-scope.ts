export function addBranchFilter(query: string, branchFilter: string) {
  const outerQuery = maskNestedSql(query)
  const groupByIndex = outerQuery.search(/\bgroup\s+by\b/i)
  const orderByIndex = outerQuery.search(/\border\s+by\b/i)
  const clauseIndex = groupByIndex >= 0 ? groupByIndex : orderByIndex
  const insertionIndex =
    clauseIndex > 0 && /\s/.test(query[clauseIndex - 1]!) ? clauseIndex - 1 : clauseIndex
  const queryStart = insertionIndex >= 0 ? query.slice(0, insertionIndex) : query
  const queryEnd = insertionIndex >= 0 ? query.slice(insertionIndex) : ''
  const conjunction = /\bwhere\b/i.test(outerQuery.slice(0, queryStart.length))
    ? ' and '
    : ' where '

  return `${queryStart}${conjunction}${branchFilter}${queryEnd}`
}

// Ignore clauses inside subqueries and quoted SQL when locating the outer filter.
// This operates on trusted model SQL; branch values remain query parameters.
function maskNestedSql(query: string) {
  let depth = 0
  let quote: string | null = null
  let masked = ''
  for (let index = 0; index < query.length; index += 1) {
    const character = query[index]!
    if (quote) {
      masked += ' '
      if (character === quote) {
        if (query[index + 1] === quote) {
          masked += ' '
          index += 1
        } else quote = null
      }
    } else if (character === "'" || character === '"') {
      quote = character
      masked += ' '
    } else if (character === '(') {
      depth += 1
      masked += ' '
    } else if (character === ')') {
      depth -= 1
      masked += ' '
    } else masked += depth === 0 ? character : ' '
  }
  return masked
}
