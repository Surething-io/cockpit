import path from 'node:path';
import { ValidationError } from '@cockpit/effect-core';

/** Normalize a cwd-relative query path without allowing traversal or absolute paths. */
export function relativeQueryPath(value: string, field: string): string {
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized.includes('\0') || path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized)
    || normalized === '..' || normalized.startsWith('../')) {
    throw new ValidationError({ field, reason: 'Must be a project-relative path within cwd' });
  }
  return normalized === '.' ? '' : normalized.replace(/\/$/, '');
}
