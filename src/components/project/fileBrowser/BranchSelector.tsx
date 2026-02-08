'use client';

import React, { useState, useEffect, useRef } from 'react';
import type { Branch } from './types';

interface BranchSelectorProps {
  branches: Branch | null;
  selectedBranch: string;
  onSelect: (branch: string) => void;
  isLoading: boolean;
}

export function BranchSelector({
  branches,
  selectedBranch,
  onSelect,
  isLoading,
}: BranchSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  const filteredLocal = branches?.local.filter(b =>
    b.toLowerCase().includes(search.toLowerCase())
  ) || [];
  const filteredRemote = branches?.remote.filter(b =>
    b.toLowerCase().includes(search.toLowerCase())
  ) || [];

  const handleSelect = (branch: string) => {
    onSelect(branch);
    setIsOpen(false);
    setSearch('');
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={isLoading}
        className="w-full px-3 py-1.5 text-sm border border-border rounded bg-card text-foreground text-left flex items-center justify-between hover:border-slate-6 dark:hover:border-slate-6 transition-colors"
      >
        <span className="truncate flex items-center gap-2">
          <svg className="w-4 h-4 text-muted-foreground flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          {selectedBranch || '选择分支...'}
          {branches?.current === selectedBranch && (
            <span className="text-xs text-green-11">(当前)</span>
          )}
        </span>
        <svg className={`w-4 h-4 text-slate-9 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute z-50 mt-1 w-full bg-card border border-border rounded-lg shadow-lg max-h-80 flex flex-col">
          <div className="p-2 border-b border-border">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索分支..."
              className="w-full px-2 py-1 text-sm border border-border rounded bg-secondary text-foreground placeholder-slate-9"
            />
          </div>
          <div className="overflow-y-auto flex-1">
            {filteredLocal.length > 0 && (
              <div>
                <div className="px-3 py-1 text-xs font-medium text-muted-foreground bg-secondary sticky top-0">
                  本地分支
                </div>
                {filteredLocal.map(branch => (
                  <div
                    key={branch}
                    onClick={() => handleSelect(branch)}
                    className={`px-3 py-1.5 text-sm cursor-pointer flex items-center gap-2 ${
                      branch === selectedBranch
                        ? 'bg-brand/10 text-brand'
                        : 'hover:bg-accent text-foreground'
                    }`}
                  >
                    <span className="truncate flex-1">{branch}</span>
                    {branch === branches?.current && (
                      <span className="text-xs text-green-11 flex-shrink-0">当前</span>
                    )}
                    {branch === selectedBranch && (
                      <svg className="w-4 h-4 text-brand flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                ))}
              </div>
            )}
            {filteredRemote.length > 0 && (
              <div>
                <div className="px-3 py-1 text-xs font-medium text-muted-foreground bg-secondary sticky top-0">
                  远程分支
                </div>
                {filteredRemote.map(branch => (
                  <div
                    key={branch}
                    onClick={() => handleSelect(branch)}
                    className={`px-3 py-1.5 text-sm cursor-pointer flex items-center gap-2 ${
                      branch === selectedBranch
                        ? 'bg-brand/10 text-brand'
                        : 'hover:bg-accent text-foreground'
                    }`}
                  >
                    <span className="truncate flex-1">{branch}</span>
                    {branch === selectedBranch && (
                      <svg className="w-4 h-4 text-brand flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                ))}
              </div>
            )}
            {filteredLocal.length === 0 && filteredRemote.length === 0 && (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                未找到分支
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
