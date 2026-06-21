import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom has no real confirm dialog; default to confirmed so flows under test proceed.
vi.spyOn(window, 'confirm').mockReturnValue(true);

afterEach(() => {
  cleanup();
});
