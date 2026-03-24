'use client';

import React from 'react';

// File icon colors in Material Icon Theme style
const FILE_COLORS: Record<string, string> = {
  // TypeScript / JavaScript
  ts: '#3178c6',
  tsx: '#3178c6',
  js: '#f1e05a',
  jsx: '#61dafb',
  mjs: '#f1e05a',
  cjs: '#f1e05a',

  // Web
  html: '#e44d26',
  css: '#563d7c',
  scss: '#cd6799',
  sass: '#cd6799',
  less: '#1d365d',
  vue: '#41b883',
  svelte: '#ff3e00',

  // Data / Config
  json: '#cbcb41',
  yaml: '#cb171e',
  yml: '#cb171e',
  toml: '#9c4121',
  xml: '#e37933',
  env: '#ecd53f',

  // Markdown / Docs
  md: '#519aba',
  mdx: '#519aba',
  txt: '#89898a',

  // Python
  py: '#3572a5',

  // Go
  go: '#00add8',

  // Rust
  rs: '#dea584',

  // Java / Kotlin
  java: '#b07219',
  kt: '#a97bff',
  kts: '#a97bff',

  // C / C++
  c: '#555555',
  h: '#555555',
  cpp: '#f34b7d',
  hpp: '#f34b7d',

  // Ruby
  rb: '#701516',

  // PHP
  php: '#4f5d95',

  // Shell
  sh: '#89e051',
  bash: '#89e051',
  zsh: '#89e051',

  // Images
  png: '#a074c4',
  jpg: '#a074c4',
  jpeg: '#a074c4',
  gif: '#a074c4',
  svg: '#ffb13b',
  webp: '#a074c4',
  ico: '#a074c4',

  // Lock files
  lock: '#89898a',

  // Git
  gitignore: '#f14e32',

  // Docker
  dockerfile: '#2496ed',

  // SQL
  sql: '#e38c00',

  // GraphQL
  graphql: '#e535ab',
  gql: '#e535ab',

  // Default
  default: '#8a8a8a',
};

// Special filename mapping
const SPECIAL_FILES: Record<string, string> = {
  'package.json': '#cb3837',
  'package-lock.json': '#cb3837',
  'tsconfig.json': '#3178c6',
  'jsconfig.json': '#f1e05a',
  '.gitignore': '#f14e32',
  '.eslintrc': '#4b32c3',
  '.eslintrc.js': '#4b32c3',
  '.eslintrc.json': '#4b32c3',
  '.prettierrc': '#56b3b4',
  'dockerfile': '#2496ed',
  '.env': '#ecd53f',
  '.env.local': '#ecd53f',
  '.env.development': '#ecd53f',
  '.env.production': '#ecd53f',
  'readme.md': '#519aba',
  'license': '#d4af37',
  'makefile': '#6d8086',
  'cargo.toml': '#dea584',
  'go.mod': '#00add8',
  'go.sum': '#00add8',
  'requirements.txt': '#3572a5',
  'yarn.lock': '#2c8ebb',
  'pnpm-lock.yaml': '#f9ad00',
  'vite.config.ts': '#646cff',
  'vite.config.js': '#646cff',
  'next.config.js': '#000000',
  'next.config.mjs': '#000000',
  'tailwind.config.js': '#38bdf8',
  'tailwind.config.ts': '#38bdf8',
};

function getFileColor(name: string): string {
  const lowerName = name.toLowerCase();
  if (SPECIAL_FILES[lowerName]) {
    return SPECIAL_FILES[lowerName];
  }
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return FILE_COLORS[ext] || FILE_COLORS.default;
}

interface FileIconProps {
  name: string;
  className?: string;
  size?: number;
}

export function FileIcon({ name, className = '', size = 16 }: FileIconProps) {
  const color = getFileColor(name);
  const ext = name.split('.').pop()?.toLowerCase() || '';

  // TypeScript
  if (['ts', 'tsx'].includes(ext)) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <rect x="2" y="2" width="20" height="20" rx="2" fill={color} />
        <path d="M7 10h10M12 10v8" stroke="white" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }

  // JavaScript
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <rect x="2" y="2" width="20" height="20" rx="2" fill={color} />
        <path d="M10 10v6c0 1-1 2-2 2M14 10v4c0 2 4 2 4 0v-4" stroke="#323330" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // React (JSX/TSX) - already handled above, this adds a React-specific variant
  if (ext === 'jsx' || (ext === 'tsx' && name.includes('component'))) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <ellipse cx="12" cy="12" rx="10" ry="4" stroke="#61dafb" strokeWidth="1.5" fill="none" />
        <ellipse cx="12" cy="12" rx="10" ry="4" stroke="#61dafb" strokeWidth="1.5" fill="none" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="10" ry="4" stroke="#61dafb" strokeWidth="1.5" fill="none" transform="rotate(120 12 12)" />
        <circle cx="12" cy="12" r="2" fill="#61dafb" />
      </svg>
    );
  }

  // JSON
  if (ext === 'json') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <path d="M6 4C4 4 4 6 4 8v2c0 1-1 2-2 2 1 0 2 1 2 2v2c0 2 0 4 2 4" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" />
        <path d="M18 4c2 0 2 2 2 4v2c0 1 1 2 2 2-1 0-2 1-2 2v2c0 2 0 4-2 4" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" />
        <circle cx="12" cy="12" r="1.5" fill={color} />
      </svg>
    );
  }

  // Markdown
  if (['md', 'mdx'].includes(ext)) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <rect x="2" y="4" width="20" height="16" rx="2" stroke={color} strokeWidth="1.5" fill="none" />
        <path d="M5 15V9l3 4 3-4v6M17 12l-2-3v6M17 12l2-3v6" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // Python
  if (['py', 'pyi', 'pyx'].includes(ext)) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <path d="M12 4c-4 0-4 2-4 3v2h5v1H6c-2 0-3 2-3 4s1 4 3 4h2v-2c0-2 1-3 3-3h4c1 0 2-1 2-2V7c0-2-2-3-5-3z" fill="#3572a5" />
        <path d="M12 20c4 0 4-2 4-3v-2h-5v-1h7c2 0 3-2 3-4s-1-4-3-4h-2v2c0 2-1 3-3 3h-4c-1 0-2 1-2 2v4c0 2 2 3 5 3z" fill="#ffd43b" />
        <circle cx="9" cy="7" r="1" fill="white" />
        <circle cx="15" cy="17" r="1" fill="white" />
      </svg>
    );
  }

  // Go
  if (ext === 'go') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <ellipse cx="12" cy="12" rx="8" ry="6" fill={color} />
        <circle cx="9" cy="11" r="1.5" fill="white" />
        <circle cx="15" cy="11" r="1.5" fill="white" />
        <circle cx="9" cy="11" r="0.7" fill="#333" />
        <circle cx="15" cy="11" r="0.7" fill="#333" />
      </svg>
    );
  }

  // Rust
  if (ext === 'rs') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="2" fill="none" />
        <circle cx="12" cy="12" r="3" fill={color} />
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3" stroke={color} strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }

  // Images
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp'].includes(ext)) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <rect x="3" y="4" width="18" height="16" rx="2" stroke={color} strokeWidth="1.5" fill="none" />
        <circle cx="8" cy="9" r="2" fill={color} />
        <path d="M3 16l5-5 3 3 4-4 6 6" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // SVG
  if (ext === 'svg') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <rect x="3" y="4" width="18" height="16" rx="2" stroke={color} strokeWidth="1.5" fill="none" />
        <path d="M7 12 Q12 6 17 12 Q12 18 7 12" stroke={color} strokeWidth="1.5" fill="none" />
      </svg>
    );
  }

  // HTML
  if (ext === 'html') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <path d="M4 3l1.5 17L12 22l6.5-2L20 3H4z" fill={color} />
        <path d="M8 7h8l-.5 6-3.5 1-3.5-1-.2-2" stroke="white" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    );
  }

  // CSS/SCSS
  if (['css', 'scss', 'sass', 'less'].includes(ext)) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <path d="M4 3l1.5 17L12 22l6.5-2L20 3H4z" fill={color} />
        <path d="M15 8H9l.3 3h5.2l-.4 4-2.1.7-2.1-.7-.1-2" stroke="white" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    );
  }

  // YAML
  if (['yaml', 'yml'].includes(ext)) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <rect x="3" y="3" width="18" height="18" rx="2" stroke={color} strokeWidth="1.5" fill="none" />
        <path d="M7 8l3 4v5M17 8l-3 4v5" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // Shell
  if (['sh', 'bash', 'zsh', 'fish'].includes(ext)) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <rect x="2" y="4" width="20" height="16" rx="2" fill="#1e1e1e" stroke="#555" strokeWidth="1" />
        <path d="M6 9l3 3-3 3M12 15h5" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // Git
  if (ext === 'gitignore' || name.toLowerCase() === '.gitignore') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <circle cx="12" cy="12" r="9" fill={color} />
        <circle cx="12" cy="12" r="3" fill="white" />
        <path d="M12 6v3M12 15v3M6 12h3M15 12h3" stroke="white" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }

  // Docker
  if (ext === 'dockerfile' || name.toLowerCase() === 'dockerfile' || name.toLowerCase().startsWith('dockerfile')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <path d="M3 12h3v3H3zM7 12h3v3H7zM11 12h3v3h-3zM7 8h3v3H7zM11 8h3v3h-3zM11 4h3v3h-3zM15 12h3v3h-3z" fill={color} />
        <path d="M21 13c-1-2-3-2-4-2h-1c0-1 0-2-2-3h-1v1c0 1-1 2-2 2H3c-1 3 0 6 2 8s5 3 9 3c5 0 8-2 10-6" stroke={color} strokeWidth="1.5" fill="none" />
      </svg>
    );
  }

  // Env files
  if (ext === 'env' || name.startsWith('.env')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <rect x="3" y="3" width="18" height="18" rx="2" stroke={color} strokeWidth="1.5" fill="none" />
        <circle cx="8" cy="8" r="2" fill={color} />
        <path d="M12 8h6M8 12h8M8 16h5" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }

  // SQL
  if (ext === 'sql') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <ellipse cx="12" cy="7" rx="8" ry="3" stroke={color} strokeWidth="1.5" fill="none" />
        <path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7" stroke={color} strokeWidth="1.5" fill="none" />
        <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" stroke={color} strokeWidth="1.5" fill="none" />
      </svg>
    );
  }

  // Vue
  if (ext === 'vue') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <path d="M2 4h4l6 10 6-10h4L12 22 2 4z" fill={color} />
        <path d="M6 4h4l2 4 2-4h4l-6 10L6 4z" fill="#35495e" />
      </svg>
    );
  }

  // Default file icon
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M6 3h8l5 5v13H6V3z" stroke={color} strokeWidth="1.5" fill="none" />
      <path d="M14 3v5h5" stroke={color} strokeWidth="1.5" fill="none" />
    </svg>
  );
}

// Folder icon (kept for future use)
interface FolderIconProps {
  isOpen?: boolean;
  className?: string;
  size?: number;
}

export function FolderIcon({ isOpen = false, className = '', size = 16 }: FolderIconProps) {
  const color = '#dcb67a';

  if (isOpen) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <path d="M2 8V6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v1" stroke={color} strokeWidth="1.5" fill="none" />
        <path d="M2 8h16a2 2 0 012 2l-2 10H4L2 10V8z" fill={color} />
      </svg>
    );
  }

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M4 4h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2z" fill={color} />
    </svg>
  );
}
