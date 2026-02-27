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

  // 分支对比模式
  const [compareMode, setCompareMode] = useState(false);
  const [savedBranch, setSavedBranch] = useState<string>(''); // 进入对比前的分支
  const [upstreamBranch, setUpstreamBranch] = useState<string>(''); // 当前分支的 upstream
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
          setHistoryError(data.error === 'Failed to get branches' ? '当前目录不是 Git 仓库' : data.error);
          setBranches(null);
        } else if (data.local && data.current) {
          setBranches(data);
          setSelectedBranch(data.current);
          if (data.upstream) setUpstreamBranch(data.upstream);
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

  // 加载分支对比文件列表
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

  // 选择对比文件查看 diff
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

  // 切换对比模式目录展开
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

  // 切换对比模式
  const toggleCompareMode = useCallback((enabled: boolean) => {
    setCompareMode(enabled);
    if (enabled) {
      // 保存当前分支，切换到 upstream 分支进行对比
      setSavedBranch(selectedBranch);
      const compareBranch = upstreamBranch || 'origin/main';
      setSelectedBranch(compareBranch);
      loadCompareFiles(compareBranch);
    } else {
      // 退出对比模式，恢复当前分支并刷新 commit 列表
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
    // 分支对比模式
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
