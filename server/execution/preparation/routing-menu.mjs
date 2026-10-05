// A skill's end-of-stage routing menu is not a product clarification.
// Only recognize explicit post-artifact menus; ordinary questions stay durable.
export function isTerminalRoutingMenu(question, method, options) {
  return method === 'select' && Array.isArray(options)
    && /(?:complete|artifact)/i.test(question)
    && /what (?:would you like to|should we) do next/i.test(question)
    && options.some((option) => /\b(?:lfg|ce-work)\b|ship it autonomously/i.test(String(option)));
}
