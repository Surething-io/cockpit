/**
 * On-disk layout of decision mode (docs/DECISION_MODE.md §10):
 *
 *   <COCKPIT_DIR>/decisions/
 *     checkouts.json                 git common-dir → project id registry
 *     <projectId>/
 *       project.json                 { enabled, enabledAt }
 *       records/<decisionId>.jsonl   append-only event log, one per decision
 *
 * Deliberately NOT under projects/<encoded-cwd>/: that directory is keyed by
 * absolute path, so moving the checkout would orphan every decision. This tree
 * is keyed by project identity (projectIdentity.ts) and is never touched by
 * snapshot retention or any other cleanup.
 */
import { join } from 'node:path';
import { COCKPIT_DIR } from '@cockpit/shared-utils';

export const decisionsDir = (): string => join(COCKPIT_DIR, 'decisions');

export const checkoutsFile = (): string => join(decisionsDir(), 'checkouts.json');

export const projectDir = (projectId: string): string => join(decisionsDir(), projectId);

export const projectStateFile = (projectId: string): string => join(projectDir(projectId), 'project.json');

export const recordsDir = (projectId: string): string => join(projectDir(projectId), 'records');

/** Decision ids are generated server-side; anything else is rejected before it reaches a path. */
export const DECISION_ID = /^dec-[a-z0-9]+-[a-z0-9]+$/;

export const recordFile = (projectId: string, decisionId: string): string =>
  join(recordsDir(projectId), `${decisionId}.jsonl`);
