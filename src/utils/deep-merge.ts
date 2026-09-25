export function isPlainObject(item: unknown): item is Record<string, unknown> {
  return typeof item === 'object' && item !== null && !Array.isArray(item);
}

/**
 * Deeply merges two objects matching yq's multiply (*) operator:
 * - Nested objects are recursively merged.
 * - Non-object values (arrays, strings, numbers, booleans, null) in override replace base.
 * - Base keys not in override are preserved.
 *
 * Pure: the returned result never shares mutable references with either input.
 * The base tree is cloned up front, override object/array values are copied
 * (structuredClone), and both base and override remain unmodified by the merge.
 */
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>
): T {
  const result: Record<string, unknown> = structuredClone(base);

  for (const key of Object.keys(override)) {
    const baseVal = base[key];
    const overrideVal = override[key];

    if (isPlainObject(baseVal) && isPlainObject(overrideVal)) {
      result[key] = deepMerge(baseVal, overrideVal);
    } else {
      result[key] = overrideVal !== null && typeof overrideVal === 'object'
        ? structuredClone(overrideVal)
        : overrideVal;
    }
  }

  return result as T;
}
