import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { Logger } from '@/lib/logger'
import { EmailService } from '@/lib/email'

export async function POST() {
  try {
    const session = await auth()

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const userId = session.user.id
    const userEmail = session.user.email || ''
    const userName = session.user.name || userEmail.split('@')[0]

    // Check if user already received daily points today
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        dailyPointsLastGiven: true,
        pointsBalance: true,
        email: true
      }
    })

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }

    const today = new Date().toDateString()
    const lastGiven = user.dailyPointsLastGiven || ''

    // Check if user already received daily points today
    if (lastGiven === today) {
      return NextResponse.json({
        success: false,
        message: 'Daily points already claimed today',
        nextAvailable: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        currentBalance: user.pointsBalance
      })
    }

    // Add daily points (5 points)
    const newBalance = user.pointsBalance + 5

    // Update user record
    await prisma.user.update({
      where: { id: userId },
      data: {
        pointsBalance: newBalance,
        dailyPointsLastGiven: today,
        updatedAt: new Date()
      }
    })

    // Try to send email notification (non-blocking)
    try {
      if (user.email) {
        await EmailService.sendDailyPointsNotification(user.email, userName, newBalance)
        Logger.info('Daily points email sent', { userId, email: user.email })
      }
    } catch (emailError) {
      Logger.error('Failed to send daily points email', { error: emailError, userId })
      // Don't fail the request if email fails
    }

    Logger.info('Daily points granted', {
      userId,
      oldBalance: user.pointsBalance,
      newBalance,
      grantedPoints: 5
    })

    return NextResponse.json({
      success: true,
      message: 'Daily points granted successfully!',
      pointsAdded: 5,
      newBalance: newBalance,
      nextAvailable: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours from now
    })

  } catch (error) {
    Logger.error('Daily points API error', { error })
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}