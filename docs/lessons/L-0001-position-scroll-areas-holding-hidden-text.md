---
id: L-0001
type: lesson
title: Position every scroll area that holds text for VoiceOver alone
status: active
visibility: public
date: 2026-10-29
summary: Text hidden with sr-only inside a scroll area that is not positioned escapes the area and lengthens the window's page, which the wheel then scrolls away; position such scroll areas and keep the page from scrolling
scope: ["src/**/renderer/**", "src/app/renderer/app.css", "tests/smoke/**"]
tags: []
level: test
occurrences: 1
---

## Symptom

```text
After a long session's timeline was scrolled past its end, the whole window moved up: an empty band
under the composer, the sidebar's divider ending above the window's foot, and with more scrolling a
blank window.
document.documentElement.scrollHeight 4570, clientHeight 700, scrollTop 3870
```

## Root cause

Tailwind's `sr-only` takes an element out of the flow with `position: absolute`, so its containing block is its nearest positioned ancestor. The session page's scroll area (`overflow-y-auto`) was not positioned, so the labels of the timeline's messages and tool calls had the window's page as their containing block. A scroll area clips only the absolutely positioned elements whose containing block lies inside it, so each label stayed where the timeline's flow put it, far below the scroll area, and the page grew to reach it. Once the timeline reached its end, the wheel scrolled the page.

## Why it looked right

The labels are one pixel, clipped and invisible. Unit tests run on happy-dom, which lays nothing out, and the screenshots set the timeline's own scroll position, so the page never scrolled while anyone looked.

## Fix

A scroll area that holds such text is positioned (`relative`), with a comment saying why: the session page's activity and the Sessions list. The window's page never scrolls (`html { overflow: hidden }` in `src/app/renderer/app.css`), so anything that escapes again is clipped instead of scrolled to. `tests/smoke/sessions.spec.ts` opens a long session and checks that the page is no taller than the window and that the wheel, past both ends of the timeline, leaves the page where it was.

## Occurrences

- 2026-10-29: the labels of the session page's messages and tool calls, in a long session.
