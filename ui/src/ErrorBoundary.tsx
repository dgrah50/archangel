import { Box, Text } from "@chakra-ui/react";
import { Component, type ReactNode } from "react";

/** A render crash (for example from malformed data) shows this instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Box role="alert" maxW="40rem" mx="auto" mt="10" p="5" borderTopWidth="1px" borderTopColor="owner">
        <Text fontWeight="medium">The dashboard hit an unexpected error and cannot be shown.</Text>
        <Text color="fg.muted" textStyle="sm" mt="1">
          {this.state.error.message}
        </Text>
        <Text textStyle="sm" mt="2">
          Reload the page. If it keeps happening, the data from the daemon may be corrupt: check `archangel status`.
        </Text>
      </Box>
    );
  }
}
