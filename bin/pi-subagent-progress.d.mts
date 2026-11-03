import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
export interface SubagentStop { reason: 'no_progress'; summary: string }
export const GUARD_NOTICE: string;
export const GUARD_STOP: string;
export const REPEAT_COUNT: number;
export const MAX_CYCLE: number;
export function createSubagentProgressGuard(): { observe(message: AgentMessage, results: ToolResultMessage[]): { action: 'warn' | 'stop'; reason: 'no_progress'; cycle: number; summary: string } | undefined };
declare const subagentProgress: ExtensionFactory;
export default subagentProgress;
