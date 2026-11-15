/** Shared test-file conventions for symbol/search filtering and affected-test queries. */
export function isTestFile(filePath: string): boolean {
  return /(^|\/)(__tests__|tests?)\//i.test(filePath)
    || /\.(test|spec|e2e)\.[^/]+$/i.test(filePath)
    || /(^|\/)test_[^/]+\.pyi?$/i.test(filePath)
    || /[^/]+_test\.go$/i.test(filePath);
}
