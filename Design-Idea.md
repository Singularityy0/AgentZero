# Design System: Agentic IDE (Cursor-Style)

## Overview
Generate a modern, highly functional, and data-dense IDE interface. The design must feel native, developer-centric, and optimized for long coding sessions. Emphasize a dark mode aesthetic, structural panel layouts, and seamless AI integration zones. 

## Tech Stack & Styling Engine
*   **Architecture:** React components.
*   **Styling:** Tailwind CSS.
*   **Visual Language:** Minimalist, flat, with strategic use of glassmorphism for contextual overlays (like command palettes or floating AI chats).

## Color Palette
*   **Base Background:** `bg-[#0a0a0a]` (Primary editor) and `bg-[#111111]` (Sidebars/Panels).
*   **Borders:** Ultra-thin and subtle. Strictly use `border-white/5` or `border-neutral-800`.
*   **Text:** Primary `text-neutral-200` (high contrast for readability). Secondary `text-neutral-500` (for file paths, hints, and muted UI).
*   **AI Accents:** Use muted, soft accents for AI features (e.g., `text-indigo-400` or a very subtle `bg-indigo-500/10` for AI-generated code diffs).

## Typography
*   **UI/Panels:** Clean sans-serif (`font-sans`, ideally Geist or Inter). Standardize on `text-sm` and `text-xs` to maintain high information density.
*   **Editor/Terminal:** Strict monospace (`font-mono`, ideally JetBrains Mono or Fira Code).

## Layout Structure
*   **Global Layout:** Full-screen, unscrollable container (`h-screen w-full flex overflow-hidden`).
*   **Activity Bar:** Narrow left/right rail (`w-12`), housing unlabelled, muted icons for navigation.
*   **Sidebar (Explorer/AI Chat):** Collapsible panel (`w-64` to `w-80`). 
*   **Editor Area:** Tabbed top navigation with subtle active states.
*   **Terminal/Console:** Resizable bottom drawer.

## Component Specifics & Effects
*   **Command Palettes & Modals (Glassmorphism):** Floating AI prompts and file search modals must use `backdrop-blur-md bg-neutral-900/80` with a 1px border and a soft drop shadow (`shadow-2xl shadow-black/50`).
*   **Hover States:** Keep transitions instantaneous or very fast (`duration-75`). Use `hover:bg-white/5` for list items and buttons.
*   **Geometry:** Avoid excessive rounding. Use `rounded-sm` or `rounded-md` to maintain a sharp, professional tool aesthetic.
*   **Scrollbars:** Custom, invisible by default, appearing only on hover as thin, dark tracks.

## Strict Generation Rules
1. Never use bright, saturated backgrounds.
2. Ensure strict alignment using Flexbox or Grid (`flex items-center gap-2`).
3. Keep padding tight (`p-1`, `p-2`) to avoid wasted space.