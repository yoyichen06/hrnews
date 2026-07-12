// 內建素材（隨 App 附帶、所有裝置都看得到、不會被刪）。
// 有 component 的是「元件」：點下去會一次加入多個可編輯元素。
// 例如「地圖輪替」= 橫線 + 可編輯地圖名稱 + 菱形徽章(IN/OUT/Map Rotation 圖)。

import { MAP_BADGE } from './map-badge.js';
import { makeText, makeImage, makeShape } from './builtins.js';

export const BUILTIN_ASSETS = [
  {
    id: 'ba_map_rotation',
    name: '地圖輪替（可改地圖名）',
    category: 'HR 素材',
    w: 530, h: 530,
    src: MAP_BADGE, // 素材庫縮圖
    // 點下去插入的元件（由後往前：地圖名稱 → 橫線 → 菱形徽章）
    component: (cx, cy, w) => [
      makeText({ label: '地圖名稱', text: 'LOTUS ABYSS', x: cx, y: cy, boxWidth: 1000,
        font: 'Oswald', weight: 700, size: 150, color: '#ffffff', hollow: true,
        stroke: { color: '#ffffff', width: 3 }, letterSpacing: 2, uppercase: true, lineHeight: 1.0 }),
      makeShape({ label: '橫線', x: cx, y: cy, w: (w || 1080) - 40, h: 6, radius: 0, fill: '#ffffff', opacity: 0.85 }),
      makeImage({ label: '地圖輪替徽章', x: cx, y: cy, w: 360, h: 360, fit: 'contain', src: MAP_BADGE }),
    ],
  },
];
