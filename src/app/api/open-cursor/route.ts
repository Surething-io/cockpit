import { exec } from 'child_process';

export async function POST(request: Request) {
  try {
    const { cwd } = await request.json();

    if (!cwd) {
      return Response.json({ error: 'cwd is required' }, { status: 400 });
    }

    // Run the cursor command to open the directory
    exec(`cursor "${cwd}"`, (error) => {
      if (error) {
        console.error('Failed to open cursor:', error);
      }
    });

    return Response.json({ success: true });
  } catch (error) {
    console.error('Error opening cursor:', error);
    return Response.json({ error: 'Failed to open cursor' }, { status: 500 });
  }
}
