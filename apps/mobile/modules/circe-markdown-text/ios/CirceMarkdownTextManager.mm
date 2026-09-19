#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "RCTBridge.h"
#import "Utils.h"

@interface CirceMarkdownTextManager : RCTViewManager
@end

@implementation CirceMarkdownTextManager

RCT_EXPORT_MODULE(CirceMarkdownText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface CirceMarkdownTextRunManager : RCTViewManager
@end

@implementation CirceMarkdownTextRunManager

RCT_EXPORT_MODULE(CirceMarkdownTextRun)

- (UIView *)view
{
  return nil;
}

@end
