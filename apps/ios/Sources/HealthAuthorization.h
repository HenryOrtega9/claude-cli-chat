#import <Foundation/Foundation.h>
#import <HealthKit/HealthKit.h>

NS_ASSUME_NONNULL_BEGIN

/// HealthKit raises an Objective-C exception (not an NSError) when the read
/// set holds a type the OS refuses to authorize, and Swift cannot catch
/// exceptions. This wrapper makes the call inside @try so no Swift frame is
/// ever unwound, and hands the exception's reason back instead.
@interface VGHealthAuthorization : NSObject

/// Returns nil when the request was handed to HealthKit (`completion` will
/// run), or the exception reason when HealthKit refused it synchronously
/// (`completion` will not run).
+ (nullable NSString *)requestReadAuthorizationWithStore:(HKHealthStore *)store
                                                   types:(NSSet<HKObjectType *> *)types
                                              completion:(void (^)(BOOL success, NSError *_Nullable error))completion
    NS_SWIFT_NAME(requestReadAuthorization(with:types:completion:));

@end

NS_ASSUME_NONNULL_END
