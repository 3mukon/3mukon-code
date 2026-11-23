---
id: L-0011
type: lesson
title: Let nothing that shows with the focus move a button under a press
status: active
visibility: public
date: 2026-11-22
summary: A press on a button gives it the focus at once, so whatever the focus shows and lays out, such as the keys on an approval's buttons, moves the button before the release, which then lands on another one and makes no click; let the button take the focus with its click, or keep the room of what shows
scope: ["src/**/renderer/**"]
tags: []
level: test
occurrences: 1
---

## Symptom

```text
A click on an approval's Deny did nothing while the block had no focus, and a second one denied.
pointerdown BUTTON:Deny, focus BUTTON:Deny, pointerup BUTTON:Allow for This Session, click DIV
```

## Root cause

An approval's and a question's buttons show the keys that press them while the block has the focus (`group-focus-within`, from `hidden` to `inline`). Chromium focuses a button as the pointer goes down on it. The keys then showed, each button grew by its own, and the last ones moved right by more than half their width, so that the release landed on their neighbour. A press and a release on two elements make a click on what holds both, which answers nothing.

## Why it looked right

The keys are a hint and take no click. The first buttons grow under the pointer without leaving it, so Allow Once and Allow for This Session answered. The unit tests click without a press and have no layout, and a person whose first click did nothing clicks again, by when the block has the focus.

## Fix

`Block` in `src/approvals/renderer/requests.tsx` keeps a press on one of its buttons from moving the focus, and gives the button the focus with its click. `requests.test.tsx` checks both. What shows with the focus elsewhere, in the archive's rows and the messages' notches, takes no room: it lies over its row or changes its opacity.

## Occurrences

- 2026-11-22: Deny on an operation's approval, found by a click in the packaged app.
