import { render, screen } from '@testing-library/react';

import { DescriptionSection } from './description-section';

const SUMMARY = '`Create or update operator group` — executes 2 on-chain actions.';

describe('DescriptionSection', () => {
  it('renders the proposer prose when there is any', () => {
    render(<DescriptionSection description="## Fund the thing" derived={SUMMARY} />);

    expect(screen.getByRole('heading', { name: 'Fund the thing' })).toBeInTheDocument();
    expect(screen.queryByText(/derived from its decoded on-chain actions/)).not.toBeInTheDocument();
  });

  it('falls back to the derived summary when the proposal has no prose', () => {
    render(<DescriptionSection description="" derived={SUMMARY} />);

    expect(screen.getByText(/derived from its decoded on-chain actions/)).toBeInTheDocument();
    expect(screen.getByText('Create or update operator group')).toBeInTheDocument();
    expect(screen.queryByText('This proposal has no description text.')).not.toBeInTheDocument();
  });

  it('renders the real summary shape: code spans, action list and field bullets', () => {
    const real = [
      '`Create or update operator group` \u2014 executes 2 on-chain actions.',
      '',
      '1. Call `validateInputData(uint256,tuple,tuple)` on `0xabc\u2026`',
      '   - `groupId`: `7`',
      '2. Call `createGroup(uint256)` on `0xdef\u2026`',
    ].join('\n');

    render(<DescriptionSection description="" derived={real} />);

    const items = screen.getAllByRole('listitem');
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items[0]).toHaveTextContent('validateInputData(uint256,tuple,tuple)');
    expect(screen.getByText('createGroup(uint256)')).toBeInTheDocument();
    expect(screen.getByText('groupId')).toBeInTheDocument();
  });

  it('says there is no text when neither prose nor a summary exists', () => {
    render(<DescriptionSection description="" />);

    expect(screen.getByText('This proposal has no description text.')).toBeInTheDocument();
  });

  it('treats a whitespace-only summary as absent', () => {
    render(<DescriptionSection description="" derived="   " />);

    expect(screen.getByText('This proposal has no description text.')).toBeInTheDocument();
  });
});
