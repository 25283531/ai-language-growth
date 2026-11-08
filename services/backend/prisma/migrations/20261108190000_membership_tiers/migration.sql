ALTER TABLE "learner_profiles"
ADD COLUMN "membershipTier" TEXT NOT NULL DEFAULT 'free';

ALTER TABLE "learner_profiles"
ADD CONSTRAINT "learner_profiles_membershipTier_check"
CHECK ("membershipTier" IN ('guest', 'free', 'member', 'advanced'));
