import { useState, useCallback, useRef } from 'react';
import { buildGitFileTree, collectGitTreeDirPaths, type GitFileNode } from '../components/project/GitFileTree';
import type { Branch, Commit, FileChange, FileDiff } from '../components/project/fileBrowser/types';
import { COMMITS_PER_PAGE } from '../components/project/fileBrowser/utils';
import i18n from '@/lib/i18n';

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

  // Branch comparison mode
  const [compareMode, setCompareMode] = useState(false);
  const [savedBranch, setSavedBranch] = useState<string>(''); // Branch saved before entering compare mode
  const [upstreamBranch, setUpstreamBranch] = useState<string>(''); // Upstream of the current branch
  const [compareFiles, setCompareFiles] = useState<FileChange[]>([]);
  const [compareFileTree, setCompareFileTree] = useState<GitFileNode<unknown>[]>([]);
  const [compareExpandedPaths, setCompareExpandedPaths] = useState<Set<string>>(new Set());
  const [compareSelectedFile, setCompareSelectedFile] = useState<FileChange | null>(null);
  const [compareFileDiff, setCompareFileDiff] = useState<FileDiff | null>(null);
  const [isLoadingCompareFiles, setIsLoadingCompareFiles] = useState(false);
  const [isLoadingCompareDiff, setIsLoadingCompareDiff] = useState(false);

  const loadBranches = useCallback(() => {
    setIsLoadingBranches(true);
    setHistoryError(null);
    fetch(`/api/git/branches?cwd=${encodeURIComponent(cwd)}`)
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          setHistoryError(data.error === 'Failed to get branches' ? i18n.t('git.notGitRepo') : data.error);
          setBranches(null);
        } else if (data.local && data.current) {
          setBranches(data);
          setSelectedBranch(data.current);
          if (data.upstream) setUpstreamBranch(data.upstream);
        } else {
          setHistoryError(i18n.t('git.cannotGetBranches'));
          setBranches(null);
        }
      })
      .catch(err => {
        console.error(err);
        setHistoryError(i18n.t('git.getBranchesFailed'));
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

  // Load the file list for branch comparison
  const loadCompareFiles = useCallback((baseBranch: string) => {
    setIsLoadingCompareFiles(true);
    setCompareSelectedFile(null);
    setCompareFileDiff(null);
    fetch(`/api/git/branch-diff?cwd=${encodeURIComponent(cwd)}&base=${encodeURIComponent(baseBranch)}`)
      .then(res => res.json())
      .then(data => {
        const fileList = data.files || [];
        setCompareFiles(fileList);
        const tree = buildGitFileTree(fileList);
        setCompareFileTree(tree);
        setCompareExpandedPaths(new Set(collectGitTreeDirPaths(tree)));
      })
      .catch(console.error)
      .finally(() => setIsLoadingCompareFiles(false));
  }, [cwd]);

  // Select a comparison file to view its diff
  const handleSelectCompareFile = useCallback((file: FileChange) => {
    setCompareSelectedFile(file);
    addToRecentFiles(file.path);
    setIsLoadingCompareDiff(true);
    fetch(`/api/git/branch-diff?cwd=${encodeURIComponent(cwd)}&base=${encodeURIComponent(selectedBranch)}&file=${encodeURIComponent(file.path)}`)
      .then(res => res.json())
      .then(data => setCompareFileDiff(data))
      .catch(console.error)
      .finally(() => setIsLoadingCompareDiff(false));
  }, [cwd, selectedBranch, addToRecentFiles]);

  // Toggle directory expansion in comparison mode
  const handleCompareToggle = useCallback((path: string) => {
    setCompareExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // Toggle comparison mode
  const toggleCompareMode = useCallback((enabled: boolean) => {
    setCompareMode(enabled);
    if (enabled) {
      // Save current branch; switch to the upstream branch for comparison
      setSavedBranch(selectedBranch);
      const compareBranch = upstreamBranch || 'origin/main';
      setSelectedBranch(compareBranch);
      loadCompareFiles(compareBranch);
    } else {
      // Exit comparison mode, restore the current branch and refresh the commit list
      setCompareFiles([]);
      setCompareFileTree([]);
      setCompareSelectedFile(null);
      setCompareFileDiff(null);
      if (savedBranch) {
        setSelectedBranch(savedBranch);
        loadCommits(savedBranch);
      }
    }
  }, [selectedBranch, savedBranch, upstreamBranch, loadCompareFiles, loadCommits]);

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
    // Branch comparison mode
    compareMode,
    toggleCompareMode,
    compareFiles,
    compareFileTree,
    compareExpandedPaths,
    compareSelectedFile,
    compareFileDiff,
    isLoadingCompareFiles,
    isLoadingCompareDiff,
    handleSelectCompareFile,
    handleCompareToggle,
    loadCompareFiles,
  };
}
