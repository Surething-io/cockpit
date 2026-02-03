import { NextRequest, NextResponse } from 'next/server';
import { serviceManager } from '@/lib/serviceManager';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd');

  let services;
  if (cwd) {
    // Get services for specific project and update access time
    services = serviceManager.getByProject(cwd);
  } else {
    // Get all services
    services = serviceManager.getAll();
  }

  return NextResponse.json(services);
}
