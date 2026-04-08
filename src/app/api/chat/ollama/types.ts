export interface ChatRequestBody {
  prompt: string;
  sessionId?: string;
  cwd?: string;
  model?: string;
  language?: string;
}

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface AgentContext {
  cwd: string;
  todos: TodoItem[];
}
