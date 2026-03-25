'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Portal } from '../shared/Portal';
import { X, CircleDot, CheckSquare, Square, Copy, PenLine } from 'lucide-react';
import { toast } from '../shared/Toast';
import type { ToolCallInfo } from '@/types/chat';

interface QuestionOption {
  label: string;
  description?: string;
}

interface QuestionItem {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

interface AskQuestionViewerModalProps {
  toolCalls: ToolCallInfo[];
  onClose: () => void;
}

/** Extract questions and answers from a single toolCall */
function extractQA(toolCall: ToolCallInfo): { questions: QuestionItem[]; answers: Record<string, string> } {
  const questions = (toolCall.input?.questions as QuestionItem[]) || [];
  const inputAnswers = (toolCall.input?.answers as Record<string, string>) || {};

  let resultAnswers: Record<string, string> = {};
  if (toolCall.result) {
    try {
      const parsed = JSON.parse(toolCall.result);
      if (parsed?.answers) {
        resultAnswers = parsed.answers;
      }
    } catch {
      // ignore
    }
  }

  return { questions, answers: { ...inputAnswers, ...resultAnswers } };
}

/** Generate a unique key for a question */
function questionKey(tcIdx: number, qIdx: number): string {
  return `${tcIdx}-${qIdx}`;
}

export function AskQuestionViewerModal({ toolCalls, onClose }: AskQuestionViewerModalProps) {
  const { t } = useTranslation();
  // Answer selection per question: key = "tcIdx-qIdx", value = selected label or custom text
  const [selections, setSelections] = useState<Record<string, string>>({});
  // Custom input expanded state
  const [customInputOpen, setCustomInputOpen] = useState<Record<string, boolean>>({});
  // Custom input text
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({});
  // Checked state (for copying): key = "tcIdx-qIdx"
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  // Initialize existing answers
  useEffect(() => {
    const initial: Record<string, string> = {};
    toolCalls.forEach((tc, tcIdx) => {
      const { questions, answers } = extractQA(tc);
      questions.forEach((q, qIdx) => {
        const answer = answers[q.question];
        if (answer) {
          const key = questionKey(tcIdx, qIdx);
          initial[key] = answer;
          if (!q.options.some(opt => opt.label === answer)) {
            setCustomInputOpen(prev => ({ ...prev, [key]: true }));
            setCustomTexts(prev => ({ ...prev, [key]: answer }));
          }
        }
      });
    });
    queueMicrotask(() => setSelections(initial));
  }, [toolCalls]);

  // ESC to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Counts
  const totalQuestions = toolCalls.reduce((sum, tc) => {
    const { questions } = extractQA(tc);
    return sum + questions.length;
  }, 0);

  const checkedCount = Object.values(checked).filter(Boolean).length;

  const handleSelectOption = useCallback((key: string, label: string) => {
    setSelections(prev => ({ ...prev, [key]: label }));
    setCustomInputOpen(prev => ({ ...prev, [key]: false }));
  }, []);

  const handleToggleCustom = useCallback((key: string) => {
    setCustomInputOpen(prev => {
      const isOpen = !prev[key];
      if (isOpen) {
        const text = customTexts[key] || '';
        if (text) {
          setSelections(s => ({ ...s, [key]: text }));
        }
      }
      return { ...prev, [key]: isOpen };
    });
  }, [customTexts]);

  const handleCustomTextChange = useCallback((key: string, text: string) => {
    setCustomTexts(prev => ({ ...prev, [key]: text }));
    if (text) {
      setSelections(prev => ({ ...prev, [key]: text }));
    }
  }, []);

  const handleToggleCheck = useCallback((key: string) => {
    setChecked(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleCopy = useCallback(() => {
    const hasChecked = checkedCount > 0;
    const parts: string[] = [];
    toolCalls.forEach((tc, tcIdx) => {
      const { questions } = extractQA(tc);
      questions.forEach((q, qIdx) => {
        const key = questionKey(tcIdx, qIdx);
        // If any are checked, copy only checked ones; otherwise copy all
        if (hasChecked && !checked[key]) return;
        const answer = selections[key];
        parts.push(`Q: ${q.question}`);
        parts.push(`A: ${answer || t('askQuestion.notSelected')}`);
        parts.push('');
      });
    });
    navigator.clipboard.writeText(parts.join('\n').trim());
    toast(hasChecked ? t('toast.copiedQA', { count: checkedCount }) : t('toast.copiedAllQA'));
  }, [toolCalls, selections, checked, checkedCount, t]);

  const modalContent = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-lg shadow-xl w-full max-w-6xl h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-medium text-foreground">{t('askQuestion.title')}</h3>
            <span className="text-xs text-muted-foreground">
              {t('askQuestion.nQuestions', { count: totalQuestions })}
              {checkedCount > 0 && ` · ${t('askQuestion.checkedN', { count: checkedCount })}`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
              title={checkedCount > 0 ? t('askQuestion.copyChecked', { count: checkedCount }) : t('askQuestion.copyAll')}
            >
              <Copy className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Questions list */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {toolCalls.map((tc, tcIdx) => {
            const { questions } = extractQA(tc);
            return questions.map((q, qIdx) => {
              const key = questionKey(tcIdx, qIdx);
              const selectedValue = selections[key];
              const isCustomOpen = customInputOpen[key] || false;
              const isChecked = checked[key] || false;

              return (
                <div key={key} className="space-y-3">
                  {/* Question header with checkbox */}
                  <div className="flex items-start gap-2">
                    <button
                      onClick={() => handleToggleCheck(key)}
                      className="mt-0.5 flex-shrink-0 p-0.5 rounded hover:bg-accent transition-colors"
                      title={t('askQuestion.checkToCopy')}
                    >
                      {isChecked
                        ? <CheckSquare className="w-4 h-4 text-brand" />
                        : <Square className="w-4 h-4 text-muted-foreground" />
                      }
                    </button>
                    {q.header && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-brand/10 text-brand flex-shrink-0 mt-0.5">
                        {q.header}
                      </span>
                    )}
                    <span className="text-sm font-medium text-foreground">{q.question}</span>
                  </div>

                  {/* Options (radio style) */}
                  <div className="space-y-1 ml-7">
                    {q.options.map((opt, j) => {
                      const isSelected = selectedValue === opt.label && !isCustomOpen;
                      return (
                        <button
                          key={j}
                          onClick={() => handleSelectOption(key, opt.label)}
                          className={`flex items-start gap-2 px-2.5 py-1.5 rounded-md transition-colors w-full text-left cursor-pointer hover:bg-accent/50 ${
                            isSelected ? 'bg-brand/10 hover:bg-brand/15' : ''
                          }`}
                        >
                          <div className="mt-0.5 flex-shrink-0">
                            {isSelected
                              ? <CircleDot className="w-3.5 h-3.5 text-brand" />
                              : <div className="w-3.5 h-3.5 rounded-full border border-muted-foreground" />
                            }
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className={`text-sm ${isSelected ? 'text-foreground font-medium' : 'text-foreground'}`}>
                              {opt.label}
                            </div>
                            {opt.description && (
                              <div className="text-xs text-muted-foreground mt-0.5">{opt.description}</div>
                            )}
                          </div>
                        </button>
                      );
                    })}

                    {/* Custom input toggle */}
                    <button
                      onClick={() => handleToggleCustom(key)}
                      className={`flex items-start gap-2 px-2.5 py-1.5 rounded-md transition-colors w-full text-left cursor-pointer hover:bg-accent/50 ${
                        isCustomOpen ? 'bg-brand/10 hover:bg-brand/15' : ''
                      }`}
                    >
                      <div className="mt-0.5 flex-shrink-0">
                        {isCustomOpen
                          ? <CircleDot className="w-3.5 h-3.5 text-brand" />
                          : <div className="w-3.5 h-3.5 rounded-full border border-muted-foreground" />
                        }
                      </div>
                      <div className="flex items-center gap-1.5">
                        <PenLine className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="text-sm text-muted-foreground">{t('askQuestion.custom')}</span>
                      </div>
                    </button>

                    {/* Custom text input */}
                    {isCustomOpen && (
                      <div className="ml-6 mt-1">
                        <input
                          type="text"
                          autoFocus
                          value={customTexts[key] || ''}
                          onChange={(e) => handleCustomTextChange(key, e.target.value)}
                          placeholder={t('askQuestion.customPlaceholder')}
                          className="w-full px-3 py-1.5 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-brand text-foreground placeholder:text-muted-foreground"
                        />
                      </div>
                    )}
                  </div>

                  {/* Divider between questions (not after last) */}
                  {!(tcIdx === toolCalls.length - 1 && qIdx === questions.length - 1) && (
                    <div className="border-b border-border/50 mt-3" />
                  )}
                </div>
              );
            });
          })}
        </div>
      </div>
    </div>
  );

  return <Portal>{modalContent}</Portal>;
}
