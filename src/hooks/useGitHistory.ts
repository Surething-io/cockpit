import { useState, useCallback, useRef } from 'react';
import { buildGitFileTree, collectGitTreeDirPaths, type GitFileNode } from '../components/project/GitFileTree';
import type { Branch, Commit, FileChange, FileDiff } from '../components/project/fileBrowser/types';
import { COMMITS_PER_PAGE } from '../components/project/fileBrowser/utils';

interface UseGitHistoryOptions {
  cwd: string;
  addToRecentFiles: (path: string) => Promise<void>;
}

export function useGitHistory({ cwd, addToRecentFiles }: UseGitHistoryOptions) {
  const [branches, setBranches] = useState<Branch | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string>('');
  const [commits, setCommits] = useState<Commit[]>([]);
  const [selectedCommit, setSelectedCommit] = useState<Commit | null>(null);
  const [historyFiles, setHistoryFiles] = useState<FileChange[]>([]);
  const [historyFileTree, setHistoryFileTree] = useState<GitFileNode<unknown>[]>([]);
  const [historyExpandedPaths, setHistoryExpandedPaths] = useState<Set<string>>(new Set());
  const [historySelectedFile, setHistorySelectedFile] = useState<FileChange | null>(null);
  const [historyFileDiff, setHistoryFileDiff] = useState<FileDiff | null>(null);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [isLoadingCommits, setIsLoadingCommits] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreCommits, setHasMoreCommits] = useState(true);
  const [isLoadingHistoryFiles, setIsLoadingHistoryFiles] = useState(false);
  const [isLoadingHistoryDiff, setIsLoadingHistoryDiff] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const commitListRef = useRef<HTMLDivElement>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  const loadBranches = useCallback(() => {
    setIsLoadingBranches(true);
    setHistoryError(null);
    fetch(`/api/git/branches?cwd=${encodeURIComponent(cwd)}`)
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          setHistoryError(data.error === 'Failed to get branches' ? '当前目录不是 Git 仓库' : data.error);
          setBranches(null);
        } else if (data.local && data.current) {
          setBranches(data);
          setSelectedBranch(data.current);
        } else {
          setHistoryError('无法获取分支信息');
          setBranches(null);
        }
      })
      .catch(err => {
        console.error(err);
        setHistoryError('获取分支信息失败');
        setBranches(null);
      })
      .finally(() => setIsLoadingBranches(false));
  }, [cwd]);

  const loadCommits = useCallback((branch: string) => {
    setIsLoadingCommits(true);
    setSelectedCommit(null);
    setHistoryFiles([]);
    setHistoryFileTree([]);
    setHistorySelectedFile(null);
    setHistoryFileDiff(null);
    setHasMoreCommits(true);
    fetch(`/api/git/commits?cwd=${encodeURIComponent(cwd)}&branch=${encodeURIComponent(branch)}&limit=${COMMITS_PER_PAGE}`)
      .then(res => res.json())
      .then(data => {
        const newCommits = data.commits || [];
        setCommits(newCommits);
        setHasMoreCommits(newCommits.length >= COMMITS_PER_PAGE);
      })
      .catch(console.error)
      .finally(() => setIsLoadingCommits(false));
  }, [cwd]);

  const loadMoreCommits = useCallback(() => {
    if (isLoadingMore || !hasMoreCommits || !selectedBranch) return;

    setIsLoadingMore(true);
    const offset = commits.length;

    fetch(`/api/git/commits?cwd=${encodeURIComponent(cwd)}&branch=${encodeURIComponent(selectedBranch)}&limit=${COMMITS_PER_PAGE}&offset=${offset}`)
      .then(res => res.json())
      .then(data => {
        const newCommits = data.commits || [];
        if (newCommits.length > 0) {
          setCommits(prev => [...prev, ...newCommits]);
        }
        setHasMoreCommits(newCommits.length >= COMMITS_PER_PAGE);
      })
      .catch(console.error)
      .finally(() => setIsLoadingMore(false));
  }, [cwd, selectedBranch, commits.length, isLoadingMore, hasMoreCommits]);

  const handleCommitListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement;
    const { scrollTop, scrollHeight, clientHeight } = target;
    if (scrollHeight - scrollTop - clientHeight < 100) {
      loadMoreCommits();
    }
  }, [loadMoreCommits]);

  const handleSelectCommit = useCallback((commit: Commit) => {
    setSelectedCommit(commit);
    setHistorySelectedFile(null);
    setHistoryFileDiff(null);
    setIsLoadingHistoryFiles(true);
    fetch(`/api/git/commit-diff?cwd=${encodeURIComponent(cwd)}&hash=${commit.hash}`)
      .then(res => res.json())
      .then(data => {
        const fileList = data.files || [];
        setHistoryFiles(fileList);
        const tree = buildGitFileTree(fileList);
        setHistoryFileTree(tree);
        setHistoryExpandedPaths(new Set(collectGitTreeDirPaths(tree)));
      })
      .catch(console.error)
      .finally(() => setIsLoadingHistoryFiles(false));
  }, [cwd]);

  const handleSelectHistoryFile = useCallback((file: FileChange) => {
    if (!selectedCommit) return;
    setHistorySelectedFile(file);
    addToRecentFiles(file.path);
    setIsLoadingHistoryDiff(true);
    fetch(`/api/git/commit-diff?cwd=${encodeURIComponent(cwd)}&hash=${selectedCommit.hash}&file=${encodeURIComponent(file.path)}`)
      .then(res => res.json())
      .then(data => setHistoryFileDiff(data))
      .catch(console.error)
      .finally(() => setIsLoadingHistoryDiff(false));
  }, [cwd, selectedCommit, addToRecentFiles]);

  const handleHistoryToggle = useCallback((path: string) => {
    setHistoryExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleCommitInfoMouseMove = useCallback((e: React.MouseEvent) => {
    setTooltipPos({ x: e.clientX, y: e.clientY });
  }, []);

  const handleCommitInfoMouseLeave = useCallback(() => {
    setTooltipPos(null);
  }, []);

  return {
    branches,
    selectedBranch,
    setSelectedBranch,
    commits,
    setCommits,
    selectedCommit,
    setSelectedCommit,
    historyFiles,
    historyFileTree,
    historyExpandedPaths,
    historySelectedFile,
    historyFileDiff,
    isLoadingBranches,
    isLoadingCommits,
    isLoadingMore,
    hasMoreCommits,
    setHasMoreCommits,
    isLoadingHistoryFiles,
    isLoadingHistoryDiff,
    historyError,
    commitListRef,
    tooltipPos,
    loadBranches,
    loadCommits,
    loadMoreCommits,
    handleCommitListScroll,
    handleSelectCommit,
    handleSelectHistoryFile,
    handleHistoryToggle,
    handleCommitInfoMouseMove,
    handleCommitInfoMouseLeave,
  };
}
