import { render, screen } from '@testing-library/react';

import { AppFooter } from './app-footer';
import { SOURCE_REPOSITORY_URL } from '../../lib/site';

describe('AppFooter', () => {
  it('attributes the public source repository in a new tab', () => {
    render(<AppFooter syncedAt={Date.now()} build="abcdef0" deployment="test" />);

    const sourceLink = screen.getByRole('link', { name: /source · GitHub/i });
    expect(sourceLink).toHaveAttribute('href', SOURCE_REPOSITORY_URL);
    expect(sourceLink).toHaveAttribute('target', '_blank');
    expect(sourceLink).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
