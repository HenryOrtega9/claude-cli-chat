#import "HealthAuthorization.h"

@implementation VGHealthAuthorization

+ (nullable NSString *)requestReadAuthorizationWithStore:(HKHealthStore *)store
                                                   types:(NSSet<HKObjectType *> *)types
                                              completion:(void (^)(BOOL success, NSError *_Nullable error))completion {
    @try {
        [store requestAuthorizationToShareTypes:nil readTypes:types completion:completion];
        return nil;
    } @catch (NSException *exception) {
        return exception.reason ?: exception.name;
    }
}

@end
