-- CreateEnum
CREATE TYPE "WorkspaceKey" AS ENUM ('THRIFT', 'INVEST', 'LOANS', 'ADMIN');

-- CreateTable
CREATE TABLE "UserWorkspace" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspace" "WorkspaceKey" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserWorkspace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserWorkspace_userId_idx" ON "UserWorkspace"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserWorkspace_userId_workspace_key" ON "UserWorkspace"("userId", "workspace");

-- AddForeignKey
ALTER TABLE "UserWorkspace" ADD CONSTRAINT "UserWorkspace_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
