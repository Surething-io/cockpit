import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

const COCKPIT_DIR = path.join(os.homedir(), '.cockpit');
const APP_STATE_FILE = path.join(COCKPIT_DIR, 'app.json');

interface AppState {
  sessionId?: string;
}

function ensureDir() {
  if (!fs.existsSync(COCKPIT_DIR)) {
    fs.mkdirSync(COCKPIT_DIR, { recursive: true });
  }
}

function readState(): AppState {
  ensureDir();
  if (!fs.existsSync(APP_STATE_FILE)) {
    return {};
  }
  try {
    const content = fs.readFileSync(APP_STATE_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function writeState(state: AppState) {
  ensureDir();
  fs.writeFileSync(APP_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

// GET: 读取状态
export async function GET() {
  const state = readState();
  return NextResponse.json(state);
}

// POST: 更新状态
export async function POST(request: Request) {
  const body = await request.json();
  const currentState = readState();
  const newState = { ...currentState, ...body };
  writeState(newState);
  return NextResponse.json(newState);
}
