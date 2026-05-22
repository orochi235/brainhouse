import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown.tsx';

describe('<Markdown>', () => {
  it('renders **bold** as <strong>', () => {
    const { container } = render(<Markdown text="hello **world**" />);
    expect(container.querySelector('strong')?.textContent).toBe('world');
  });

  it('renders fenced code blocks', () => {
    const { container } = render(<Markdown text={'```js\nconst x = 1;\n```'} />);
    expect(container.querySelector('pre code')).toBeInTheDocument();
  });

  it('renders GFM tables', () => {
    const { container } = render(<Markdown text={'| a | b |\n| - | - |\n| 1 | 2 |'} />);
    expect(container.querySelector('table')).toBeInTheDocument();
  });

  it('escapes raw HTML by default (no rehype-raw configured)', () => {
    // react-markdown doesn't parse raw HTML unless rehype-raw is enabled, so
    // a literal <script> tag renders as text.
    const { container } = render(<Markdown text={'<script>alert(1)</script>'} />);
    expect(container.querySelector('script')).toBeNull();
  });

  it('escape=true preserves angle brackets as text rather than markdown', () => {
    const { container } = render(<Markdown text="<hr>" escape />);
    // Either renders as literal text containing the brackets, OR as an
    // entity-encoded paragraph. Either way, no real <hr> appears.
    expect(container.querySelector('hr')).toBeNull();
    expect(container.textContent).toContain('<hr>');
  });

  it('renders inline code with the `code` element', () => {
    const { container } = render(<Markdown text="use `foo()` here" />);
    expect(container.querySelector('code')?.textContent).toBe('foo()');
  });
});
