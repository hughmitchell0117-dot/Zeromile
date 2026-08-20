import { Component, type ErrorInfo, type ReactNode } from 'react';

/*
 * Without this the whole page is one throw away from going white: React
 * unmounts the entire tree on an uncaught render or effect error and never
 * puts it back. Friends left the demo open for an hour and came back to a
 * blank tab, with nothing on screen to say what happened or what to do.
 */

type Props = { children: ReactNode };
type State = { error: Error | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The console is where we look first when someone reports a dead page, so
    // keep the component stack rather than only the message.
    console.error('ZeroMile crashed', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="zm-crash" role="alert">
        <div className="zm-crash-card">
          <p className="zm-crash-title">화면을 다시 불러와 주세요</p>
          <p className="zm-crash-body">
            데모가 중단됐습니다. 새로고침하면 처음부터 다시 시작합니다.
          </p>
          <button type="button" onClick={() => window.location.reload()}>
            새로고침
          </button>
          <p className="zm-crash-detail">{error.message}</p>
        </div>
      </div>
    );
  }
}
