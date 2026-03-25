#!/usr/bin/env python3
"""
Jupyter kernel bridge for Cockpit.
Manages a single IPython kernel, communicates via JSON-over-stdio.

stdin (commands):
  {"cmd": "execute", "msg_id": "xxx", "code": "print('hello')"}
  {"cmd": "interrupt"}
  {"cmd": "complete", "msg_id": "xxx", "code": "pri", "cursor_pos": 3}
  {"cmd": "shutdown"}

stdout (kernel messages):
  {"type": "ready", "kernel_id": "..."}
  {"msg_id": "xxx", "msg_type": "stream", "content": {"name": "stdout", "text": "hello\n"}}
  {"msg_id": "xxx", "msg_type": "execute_result", "content": {"execution_count": 1, "data": {...}, "metadata": {}}}
  {"msg_id": "xxx", "msg_type": "display_data", "content": {"data": {...}, "metadata": {}}}
  {"msg_id": "xxx", "msg_type": "error", "content": {"ename": "...", "evalue": "...", "traceback": [...]}}
  {"msg_id": "xxx", "msg_type": "status", "content": {"execution_state": "idle"}}
  {"type": "error", "message": "..."}
"""

import sys
import json
import threading
import os

def emit(obj):
    """Write a JSON line to stdout."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()

def main():
    # Check dependencies
    try:
        import jupyter_client
    except ImportError:
        emit({"type": "error", "message": "jupyter_client not found. Run: pip install ipykernel"})
        sys.exit(1)

    cwd = os.environ.get('JUPYTER_CWD', os.getcwd())

    # Start kernel
    try:
        km = jupyter_client.KernelManager(kernel_name='python3')
        km.start_kernel(cwd=cwd)
    except Exception as e:
        emit({"type": "error", "message": f"Failed to start kernel: {e}"})
        sys.exit(1)

    kc = km.client()
    kc.start_channels()

    # Wait for kernel to be ready
    try:
        kc.wait_for_ready(timeout=30)
    except Exception as e:
        emit({"type": "error", "message": f"Kernel not ready: {e}"})
        km.shutdown_kernel(now=True)
        sys.exit(1)

    emit({"type": "ready", "kernel_id": str(km.kernel_id)})

    # Track which msg_ids are active (execute requests in progress)
    active_executions = {}  # parent_msg_id -> original msg_id from client
    shutdown_flag = threading.Event()

    def iopub_listener():
        """Background thread: read IOPub messages and emit them."""
        while not shutdown_flag.is_set():
            try:
                msg = kc.get_iopub_msg(timeout=1)
            except Exception:
                continue

            msg_type = msg.get('msg_type', '')
            parent_id = msg.get('parent_header', {}).get('msg_id', '')
            content = msg.get('content', {})

            # Map parent_msg_id back to client's msg_id
            client_msg_id = active_executions.get(parent_id, parent_id)

            if msg_type in ('stream', 'execute_result', 'display_data', 'update_display_data', 'error'):
                out = {
                    "msg_id": client_msg_id,
                    "msg_type": msg_type,
                    "content": content,
                }
                emit(out)
            elif msg_type == 'status':
                state = content.get('execution_state', '')
                emit({
                    "msg_id": client_msg_id,
                    "msg_type": "status",
                    "content": {"execution_state": state},
                })
                if state == 'idle' and parent_id in active_executions:
                    del active_executions[parent_id]

    listener = threading.Thread(target=iopub_listener, daemon=True)
    listener.start()

    # Main loop: read commands from stdin
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            try:
                cmd = json.loads(line)
            except json.JSONDecodeError:
                continue

            action = cmd.get('cmd', '')

            if action == 'execute':
                code = cmd.get('code', '')
                client_msg_id = cmd.get('msg_id', '')
                reply = kc.execute(code, allow_stdin=False)
                # reply is the kernel's msg_id — map it to client's msg_id
                active_executions[reply] = client_msg_id

            elif action == 'interrupt':
                try:
                    km.interrupt_kernel()
                except Exception as e:
                    emit({"type": "error", "message": f"Interrupt failed: {e}"})

            elif action == 'complete':
                code = cmd.get('code', '')
                cursor_pos = cmd.get('cursor_pos', len(code))
                client_msg_id = cmd.get('msg_id', '')
                reply_id = kc.complete(code, cursor_pos)
                try:
                    reply = kc.get_shell_msg(timeout=5)
                    emit({
                        "msg_id": client_msg_id,
                        "msg_type": "complete_reply",
                        "content": reply.get('content', {}),
                    })
                except Exception:
                    emit({
                        "msg_id": client_msg_id,
                        "msg_type": "complete_reply",
                        "content": {"matches": [], "status": "error"},
                    })

            elif action == 'shutdown':
                break

    except (EOFError, KeyboardInterrupt):
        pass
    finally:
        shutdown_flag.set()
        try:
            kc.stop_channels()
            km.shutdown_kernel(now=True)
        except Exception:
            pass

if __name__ == '__main__':
    main()
