import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from './button';
import { SettingGroup, SettingItem, SettingProblem } from './setting-group';

afterEach(cleanup);

describe('SettingGroup', () => {
  it('names its items’ setting by its title and detail, each item with its state, line and buttons', () => {
    const onClick = vi.fn();
    render(
      <SettingGroup label="Computer use" detail="What macOS lets agents see and do in other apps.">
        <SettingItem
          name="Accessibility"
          state="Allowed"
          stateTone="success"
          line="Reading and pressing other apps’ controls"
        />
        <SettingItem name="Screen Recording" line="Seeing other apps’ windows">
          <Button label="Open System Settings" onClick={onClick} />
          <Button label="Later" disabled onClick={onClick} />
        </SettingItem>
        <SettingProblem text="That didn’t work." />
      </SettingGroup>,
    );
    const group = screen.getByRole('region', { name: 'Computer use' });
    expect(group.getAttribute('aria-describedby')).not.toBeNull();
    expect(within(group).getByText('Allowed').className).toContain('text-run');
    expect(within(group).getByText('Seeing other apps’ windows')).toBeDefined();
    expect(within(group).getByRole('status').textContent).toBe('That didn’t work.');
    fireEvent.click(within(group).getByRole('button', { name: 'Open System Settings' }));
    fireEvent.click(within(group).getByRole('button', { name: 'Later' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('outlines its items as one group, with no line between them', () => {
    render(
      <SettingGroup label="Browser use">
        <SettingItem name="App’s browser" line="Its sign-ins, shared by every session" />
        <SettingItem name="Chrome" line="Personal profile, with its tabs and sign-ins" />
      </SettingGroup>,
    );
    const group = screen.getByRole('region', { name: 'Browser use' });
    expect(group.querySelector('.border-dashed')).not.toBeNull();
    expect(group.querySelector('.divide-y')).toBeNull();
  });

  it('describes nothing when it has no detail', () => {
    render(
      <SettingGroup label="Browser use">
        <SettingItem name="App’s browser" line="Its sign-ins, shared by every session" />
      </SettingGroup>,
    );
    expect(
      screen.getByRole('region', { name: 'Browser use' }).getAttribute('aria-describedby'),
    ).toBeNull();
  });
});
