#import <CoreImage/CoreImage.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>

#include "capture/snapshot.h"

namespace broadify::pgm {

std::string jpegBase64FromFrame(const CapturedFrame &frame, double quality, uint32_t &outWidth, uint32_t &outHeight) {
  @autoreleasepool {
    CVPixelBufferRef buffer = frame.pixelBuffer;
    if (buffer == nullptr) {
      return "";
    }
    static CIContext *context = [CIContext contextWithOptions:@{kCIContextUseSoftwareRenderer : @NO}];
    CIImage *image = [CIImage imageWithCVPixelBuffer:buffer];
    if (image == nil) {
      return "";
    }
    outWidth = static_cast<uint32_t>(CVPixelBufferGetWidth(buffer));
    outHeight = static_cast<uint32_t>(CVPixelBufferGetHeight(buffer));
    CGColorSpaceRef colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    NSData *jpeg = [context JPEGRepresentationOfImage:image
                                            colorSpace:colorSpace
                                               options:@{(__bridge NSString *)kCGImageDestinationLossyCompressionQuality : @(quality)}];
    CGColorSpaceRelease(colorSpace);
    if (jpeg == nil || jpeg.length == 0) {
      return "";
    }
    NSString *base64 = [jpeg base64EncodedStringWithOptions:0];
    return std::string([base64 UTF8String] ?: "");
  }
}

}  // namespace broadify::pgm
