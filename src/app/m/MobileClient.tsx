'use client';

// Client boundary for the mobile route. The server page.tsx renders this, so
// the @cockpit/feature-agent barrel (which re-exports client-only hooks) is
// entered from within a "use client" module — mirroring how the desktop page
// reaches feature code through the client <Workspace>. Importing the barrel
// directly from the server page pulls client hooks into the server graph and
// fails the production build.
import { MobileApp } from '@cockpit/feature-agent';

interface MobileClientProps {
  initialCwd?: string;
  initialSessionId?: string;
}

export default function MobileClient(props: MobileClientProps) {
  return <MobileApp {...props} />;
}
