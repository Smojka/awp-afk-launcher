import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom has no real confirm dialog; default to confirmed so flows under test proceed.
if (typeof window !== 'undefined') {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
}

afterEach(() => {
  if (typeof document !== 'undefined') {
    cleanup();
  }
});
