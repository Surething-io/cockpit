'use client';

import { useState, useEffect, useCallback, useRef, ReactNode, createContext, useContext } from 'react';
import { createPortal } from 'react-dom';
import { toast } from './Toast';

// Context for menu container - allows FileContextMenu to portal to a specific container
const MenuContainerContext = createContext<HTMLElement | null>(null);

export function MenuContainerProvider({ container, children }: { container: HTMLElement | null; children: ReactNode }) {
  return (
    <MenuContainerContext.Provider value={container}>
      {children}
    </MenuContainerContext.Provider>
  );
}

interface FileContextMenuProps {
  x: number;
  y: number;
  path: string; // 相对路径
  cwd: string; // 工作目录
  isDirectory: boolean;
  onClose: () => void;
}

export function FileContextMenu({ x, y, path, cwd, isDirectory, onClose }: FileContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const menuContainer = useContext(MenuContainerContext);

  // 计算各种路径
  const fileName = path.split('/').pop() || path;
  const absolutePath = `${cwd}/${path}`;
  const relativeDirPath = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
  const absoluteDirPath = relativeDirPath ? `${cwd}/${relativeDirPath}` : cwd;

  // 如果是目录，目录路径就是自己
  const actualRelativeDirPath = isDirectory ? path : relativeDirPath;
  const actualAbsoluteDirPath = isDirectory ? absolutePath : absoluteDirPath;

  // 点击外部关闭菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // 计算相对于容器的位置
  const [position, setPosition] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (menuRef.current && menuContainer) {
      const containerRect = menuContainer.getBoundingClientRect();
      const menuRect = menuRef.current.getBoundingClientRect();

      // 计算相对于容器的坐标
      let relX = x - containerRect.left;
      let relY = y - containerRect.top;

      // 避免超出容器边界
      relX = Math.min(relX, containerRect.width - menuRect.width - 8);
      relY = Math.min(relY, containerRect.height - menuRect.height - 8);
      relX = Math.max(8, relX);
      relY = Math.max(8, relY);

      setPosition({ x: relX, y: relY });
    } else if (menuRef.current) {
      // 没有容器时，使用视口坐标
      const rect = menuRef.current.getBoundingClientRect();
      const newX = Math.min(x, window.innerWidth - rect.width - 8);
      const newY = Math.min(y, window.innerHeight - rect.height - 8);
      setPosition({ x: Math.max(8, newX), y: Math.max(8, newY) });
    }
  }, [x, y, menuContainer]);

  const copyToClipboard = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制${label}`, 'success');
    } catch {
      toast('复制失败', 'error');
    }
    onClose();
  }, [onClose]);

  const menuItems = [
    { label: '复制相对路径', value: path },
    { label: '复制绝对路径', value: absolutePath },
    { label: '复制相对文件夹路径', value: actualRelativeDirPath || '.' },
    { label: '复制绝对文件夹路径', value: actualAbsoluteDirPath },
    { label: isDirectory ? '复制文件夹名' : '复制文件名', value: fileName },
  ];

  const menuElement = (
    <div
      ref={menuRef}
      className="absolute z-[200] bg-card border border-border rounded-lg shadow-lg py-1 w-fit whitespace-nowrap"
      style={{ left: position.x, top: position.y }}
    >
      {menuItems.map((item, index) => (
        <button
          key={index}
          className="block w-full px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent transition-colors"
          onClick={() => copyToClipboard(item.value, item.label.replace('复制', ''))}
        >
          {item.label}
        </button>
      ))}
    </div>
  );

  // Portal 到指定容器，或直接渲染
  if (menuContainer) {
    return createPortal(menuElement, menuContainer);
  }
  return menuElement;
}

// Hook for managing context menu state
export function useFileContextMenu() {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    path: string;
    isDirectory: boolean;
  } | null>(null);

  const showContextMenu = useCallback((e: React.MouseEvent, path: string, isDirectory: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, path, isDirectory });
  }, []);

  const hideContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  return { contextMenu, showContextMenu, hideContextMenu };
}

// Context menu wrapper component for easy integration
interface FileContextMenuWrapperProps {
  children: ReactNode;
  path: string;
  cwd: string;
  isDirectory: boolean;
  className?: string;
  style?: React.CSSProperties;
  onClick?: (e: React.MouseEvent) => void;
}

export function FileContextMenuWrapper({
  children,
  path,
  cwd,
  isDirectory,
  className,
  style,
  onClick,
}: FileContextMenuWrapperProps) {
  const { contextMenu, showContextMenu, hideContextMenu } = useFileContextMenu();

  return (
    <>
      <div
        className={className}
        style={style}
        onClick={onClick}
        onContextMenu={(e) => showContextMenu(e, path, isDirectory)}
      >
        {children}
      </div>
      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          path={contextMenu.path}
          cwd={cwd}
          isDirectory={contextMenu.isDirectory}
          onClose={hideContextMenu}
        />
      )}
    </>
  );
}
