export interface ChatRequestBody {
  prompt: string;
  sessionId?: string;
  cwd?: string;
  model?: string;
  language?: string;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface AgentContext {
  cwd: string;
  todos: TodoItem[];
}
