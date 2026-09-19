#pragma once

#include <react/renderer/components/CirceMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/CirceMarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <string>
#include <vector>

namespace facebook::react {

extern const char CirceMarkdownTextComponentName[];

struct CirceMarkdownTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;
};

struct CirceMarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;
  /// Recolor the loaded image with the run's foreground color, like `sf:` symbols.
  bool tintWithForeground;
  Float chipWidth = 0;
  Float chipHeight = 0;
};

inline Float CirceMarkdownTextAttachmentSize(const CirceMarkdownTextAttachmentRange &) {
  return 14;
}

inline Float CirceMarkdownTextAttachmentBaselineOffset(
    const CirceMarkdownTextAttachmentRange &) {
  return -2;
}

class CirceMarkdownTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<CirceMarkdownTextParagraphStyleRange> paragraphStyleRanges;
  std::vector<CirceMarkdownTextAttachmentRange> attachmentRanges;
};

class CirceMarkdownTextShadowNode final : public ConcreteViewShadowNode<
CirceMarkdownTextComponentName,
CirceMarkdownTextProps,
CirceMarkdownTextEventEmitter,
CirceMarkdownTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  CirceMarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<CirceMarkdownTextParagraphStyleRange> _paragraphStyleRanges;
  mutable std::vector<CirceMarkdownTextAttachmentRange> _attachmentRanges;
};
} // namespace facebook::React
