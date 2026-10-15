/**
 * 左半区：代码查看器。
 */
import { StyleSheet, View } from 'react-native';
import type { ReactNode } from 'react';
import { colors } from '../../theme';
import { CodeView } from './CodeView';

export function CodePane(): ReactNode {
  return (
    <View style={styles.container} testID="code-pane">
      <CodeView />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.panel, overflow: 'hidden' },
});
