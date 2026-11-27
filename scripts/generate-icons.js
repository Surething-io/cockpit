const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];
const outputDir = path.join(__dirname, '../public/icons');
const devOutputDir = path.join(__dirname, '../public/icons/dev');
// Served by the manifest when cockpit is reached through a non-loopback host, so
// a PWA installed from a remote server can be told apart from the local one.
const remoteOutputDir = path.join(__dirname, '../public/icons/remote');
// Served when it is reached through localhost: a PWA installed from the local
// server, told apart from the desktop app, which keeps the plain icon.
const localOutputDir = path.join(__dirname, '../public/icons/local');

// 创建驾驶舱图标 SVG - 体现"掌控万物"的意境
// 设计：黑底圆角方形 - C 形弧线（开口向下）+ 中心控制点，象征 Cockpit 品牌 + 保护/掌控
// variant: 'prod' | 'dev' | 'remote' | 'local'
const createIconSvg = (size, variant = 'prod') => {
  const isDev = variant === 'dev';
  const isRemote = variant === 'remote';
  const isLocal = variant === 'local';
  const cx = size / 2;
  const cy = size / 2;
  const bgSize = size * 0.9;      // 背景方形大小
  const bgRadius = size * 0.18;   // 圆角半径
  const cRadius = size * 0.28;    // C 形弧线半径
  const strokeWidth = size * 0.06; // C 形线条粗细

  // C 形弧线：开口向下，从左下到右下画弧（约 270 度）
  const startAngle = 135 * (Math.PI / 180);  // 左下 135°
  const endAngle = 45 * (Math.PI / 180);     // 右下 45°

  const startX = cx + cRadius * Math.cos(startAngle);
  const startY = cy + cRadius * Math.sin(startAngle);
  const endX = cx + cRadius * Math.cos(endAngle);
  const endY = cy + cRadius * Math.sin(endAngle);

  const bgOffset = (size - bgSize) / 2;

  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <!-- 圆角方形黑色背景 -->
      <rect x="${bgOffset}" y="${bgOffset}" width="${bgSize}" height="${bgSize}" rx="${bgRadius}" ry="${bgRadius}" fill="#18181b"/>

      <!-- C 形弧线 - 开口向下 -->
      <path
        d="M ${startX} ${startY} A ${cRadius} ${cRadius} 0 1 1 ${endX} ${endY}"
        fill="none"
        stroke="#ffffff"
        stroke-width="${strokeWidth}"
        stroke-linecap="round"
      />

      <!-- 中心控制点 - 发光效果 -->
      <circle cx="${cx}" cy="${cy}" r="${size * 0.08}" fill="#ffffff" opacity="0.3"/>
      <circle cx="${cx}" cy="${cy}" r="${size * 0.05}" fill="#ffffff"/>

      ${isDev ? `
      <!-- Dev 环境四角星角标 -->
      <path d="M ${size * 0.78} ${size * 0.13}
               L ${size * 0.81} ${size * 0.19}
               L ${size * 0.87} ${size * 0.22}
               L ${size * 0.81} ${size * 0.25}
               L ${size * 0.78} ${size * 0.31}
               L ${size * 0.75} ${size * 0.25}
               L ${size * 0.69} ${size * 0.22}
               L ${size * 0.75} ${size * 0.19}
               Z" fill="#f97316"/>
      ` : ''}

      ${isRemote ? `
      <!-- Remote badge: a globe on a teal disc, where the dev sparkle sits.
           The dark ring keeps it readable against the white arc. -->
      <circle cx="${size * 0.78}" cy="${size * 0.22}" r="${size * 0.115}" fill="#18181b"/>
      <circle cx="${size * 0.78}" cy="${size * 0.22}" r="${size * 0.095}" fill="#14a39a"/>
      <g fill="none" stroke="#ffffff" stroke-width="${size * 0.014}" stroke-linecap="round">
        <circle cx="${size * 0.78}" cy="${size * 0.22}" r="${size * 0.06}"/>
        <ellipse cx="${size * 0.78}" cy="${size * 0.22}" rx="${size * 0.026}" ry="${size * 0.06}"/>
        <line x1="${size * 0.72}" y1="${size * 0.22}" x2="${size * 0.84}" y2="${size * 0.22}"/>
      </g>
      ` : ''}

      ${isLocal ? `
      <!-- Local badge: a laptop on a grey disc, same spot and ring as remote. -->
      <circle cx="${size * 0.78}" cy="${size * 0.22}" r="${size * 0.115}" fill="#18181b"/>
      <circle cx="${size * 0.78}" cy="${size * 0.22}" r="${size * 0.095}" fill="#71717a"/>
      <rect x="${size * 0.737}" y="${size * 0.178}" width="${size * 0.086}" height="${size * 0.058}" rx="${size * 0.008}"
            fill="none" stroke="#ffffff" stroke-width="${size * 0.013}"/>
      <line x1="${size * 0.722}" y1="${size * 0.257}" x2="${size * 0.838}" y2="${size * 0.257}"
            stroke="#ffffff" stroke-width="${size * 0.015}" stroke-linecap="round"/>
      ` : ''}
    </svg>
  `;
};

async function generateIcons() {
  // 确保输出目录存在
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  if (!fs.existsSync(devOutputDir)) {
    fs.mkdirSync(devOutputDir, { recursive: true });
  }
  if (!fs.existsSync(remoteOutputDir)) {
    fs.mkdirSync(remoteOutputDir, { recursive: true });
  }
  if (!fs.existsSync(localOutputDir)) {
    fs.mkdirSync(localOutputDir, { recursive: true });
  }

  for (const size of sizes) {
    // 生成 production 图标
    const svg = createIconSvg(size, false);
    const outputPath = path.join(outputDir, `icon-${size}x${size}.png`);
    await sharp(Buffer.from(svg))
      .resize(size, size)
      .png()
      .toFile(outputPath);
    console.log(`Generated: icon-${size}x${size}.png`);

    // 生成 dev 图标（带橙色角标）
    const devSvg = createIconSvg(size, 'dev');
    const devOutputPath = path.join(devOutputDir, `icon-${size}x${size}.png`);
    await sharp(Buffer.from(devSvg))
      .resize(size, size)
      .png()
      .toFile(devOutputPath);
    console.log(`Generated: dev/icon-${size}x${size}.png`);

    const remoteSvg = createIconSvg(size, 'remote');
    await sharp(Buffer.from(remoteSvg))
      .resize(size, size)
      .png()
      .toFile(path.join(remoteOutputDir, `icon-${size}x${size}.png`));
    console.log(`Generated: remote/icon-${size}x${size}.png`);

    const localSvg = createIconSvg(size, 'local');
    await sharp(Buffer.from(localSvg))
      .resize(size, size)
      .png()
      .toFile(path.join(localOutputDir, `icon-${size}x${size}.png`));
    console.log(`Generated: local/icon-${size}x${size}.png`);
  }

  // 生成 favicon
  const faviconSvg = createIconSvg(32);
  await sharp(Buffer.from(faviconSvg))
    .resize(32, 32)
    .png()
    .toFile(path.join(outputDir, '../favicon.ico'));

  console.log('Generated: favicon.ico');
  console.log('All icons generated successfully!');
}

generateIcons().catch(console.error);
