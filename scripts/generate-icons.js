const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];
const outputDir = path.join(__dirname, '../public/icons');

// 创建驾驶舱图标 SVG - 体现"掌控万物"的意境
// 设计：同心圆 + 十字准星 + 中心控制点，象征雷达/控制界面
const createIconSvg = (size) => {
  const cx = size / 2;
  const cy = size / 2;
  const maxRadius = size * 0.35;

  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#0f172a;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#1e293b;stop-opacity:1" />
        </linearGradient>
        <linearGradient id="glowGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#38bdf8;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#0ea5e9;stop-opacity:1" />
        </linearGradient>
      </defs>

      <!-- 背景 - 透明 -->
      <rect width="${size}" height="${size}" fill="transparent"/>

      <!-- 外圈 -->
      <circle cx="${cx}" cy="${cy}" r="${maxRadius}"
              fill="none" stroke="#000000" stroke-width="${size * 0.015}" opacity="0.3"/>

      <!-- 中圈 -->
      <circle cx="${cx}" cy="${cy}" r="${maxRadius * 0.65}"
              fill="none" stroke="#000000" stroke-width="${size * 0.015}" opacity="0.5"/>

      <!-- 内圈 -->
      <circle cx="${cx}" cy="${cy}" r="${maxRadius * 0.35}"
              fill="none" stroke="#000000" stroke-width="${size * 0.02}" opacity="0.8"/>

      <!-- 十字准星 - 水平线 -->
      <line x1="${cx - maxRadius}" y1="${cy}" x2="${cx - maxRadius * 0.5}" y2="${cy}"
            stroke="#000000" stroke-width="${size * 0.015}" opacity="0.6"/>
      <line x1="${cx + maxRadius * 0.5}" y1="${cy}" x2="${cx + maxRadius}" y2="${cy}"
            stroke="#000000" stroke-width="${size * 0.015}" opacity="0.6"/>

      <!-- 十字准星 - 垂直线 -->
      <line x1="${cx}" y1="${cy - maxRadius}" x2="${cx}" y2="${cy - maxRadius * 0.5}"
            stroke="#000000" stroke-width="${size * 0.015}" opacity="0.6"/>
      <line x1="${cx}" y1="${cy + maxRadius * 0.5}" x2="${cx}" y2="${cy + maxRadius}"
            stroke="#000000" stroke-width="${size * 0.015}" opacity="0.6"/>

      <!-- 中心控制点 - 发光效果 -->
      <circle cx="${cx}" cy="${cy}" r="${size * 0.06}" fill="#000000" opacity="0.3"/>
      <circle cx="${cx}" cy="${cy}" r="${size * 0.04}" fill="#000000"/>

      <!-- 四角标记点 - 象征可控制的节点 -->
      <circle cx="${cx - maxRadius * 0.7}" cy="${cy - maxRadius * 0.7}" r="${size * 0.02}" fill="#000000" opacity="0.7"/>
      <circle cx="${cx + maxRadius * 0.7}" cy="${cy - maxRadius * 0.7}" r="${size * 0.02}" fill="#000000" opacity="0.7"/>
      <circle cx="${cx - maxRadius * 0.7}" cy="${cy + maxRadius * 0.7}" r="${size * 0.02}" fill="#000000" opacity="0.7"/>
      <circle cx="${cx + maxRadius * 0.7}" cy="${cy + maxRadius * 0.7}" r="${size * 0.02}" fill="#000000" opacity="0.7"/>
    </svg>
  `;
};

async function generateIcons() {
  // 确保输出目录存在
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (const size of sizes) {
    const svg = createIconSvg(size);
    const outputPath = path.join(outputDir, `icon-${size}x${size}.png`);

    await sharp(Buffer.from(svg))
      .resize(size, size)
      .png()
      .toFile(outputPath);

    console.log(`Generated: icon-${size}x${size}.png`);
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
